import { createHash, randomUUID } from "node:crypto";
import {
  BillingWebhookRejectedError,
  PlanSchema,
  SeatLimitExceededError,
  UsageConflictError,
  UsageEventSchema,
  UsageQuotaExceededError,
  entitlementsForPlan,
  isBillingEventNewer,
  verifyBillingWebhookSignature,
  parseBillingWebhookEvent,
  type BillingWebhookEvent,
  type BillingWebhookHandlerPort,
  type EntitlementServicePort,
  type Plan,
  type PlanEntitlements,
  type UsageEvent,
  type UsageLedgerPort,
  type UsageRecordResult,
  type UsageSummary,
} from "./registry-telemetry.js";
import type {
  RegistrySqlConnection,
  RegistrySqlExecutor,
  RegistrySqlPool,
} from "./registry-postgres.js";

export class PostgresRegistryUsageLedger implements UsageLedgerPort {
  readonly #pool: RegistrySqlPool;
  readonly #billingMode: "off" | "enforced";
  readonly #clock: () => Date;

  constructor(
    pool: RegistrySqlPool,
    billingMode: "off" | "enforced" = "off",
    clock: () => Date = () => new Date(),
  ) {
    this.#pool = pool;
    this.#billingMode = billingMode;
    this.#clock = clock;
  }

  async record(input: unknown): Promise<UsageRecordResult> {
    const event = UsageEventSchema.parse(input);
    return withTransaction(
      this.#pool,
      (connection) => recordUsageEvent(connection, event),
      event.org_id,
    );
  }

  async recordWithQuota(
    input: unknown,
  ): Promise<UsageRecordResult & { quota: { used: number; duplicate: boolean } }> {
    const event = UsageEventSchema.parse(input);
    if (event.kind === "download") {
      throw new UsageConflictError();
    }
    const orgId = event.org_id;
    const quotaAt = this.#now();
    return withTransaction(this.#pool, async (connection) => {
      const quota = await reserveQuota(
        connection,
        this.#billingMode,
        orgId,
        1,
        event.event_id,
        quotaAt,
      );
      const recorded = await recordUsageEvent(connection, event);
      if (recorded.created === quota.duplicate) {
        throw new UsageConflictError();
      }
      return { ...recorded, quota };
    }, orgId);
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Registry usage clock returned an invalid Date");
    }
    return value.toISOString();
  }

  async summary(
    filter: { packageName?: string; orgId?: string | null } = {},
  ): Promise<UsageSummary> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (filter.packageName !== undefined) {
      values.push(filter.packageName);
      where.push(`package_name = $${values.length}`);
    }
    if (filter.orgId === null) {
      where.push("org_id IS NULL");
    } else if (filter.orgId !== undefined) {
      values.push(filter.orgId);
      where.push(`org_id = $${values.length}`);
    }
    const summarySql = `SELECT kind, count(*)::integer AS count
         FROM registry_usage_events
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY kind`;
    // Org-scoped summaries run under the tenant RLS context. The unscoped
    // branch stays on the pool: under row-level security a non-owner runtime
    // role legitimately sees no rows there.
    const result =
      typeof filter.orgId === "string"
        ? await withTransaction(
            this.#pool,
            (connection) => connection.query(summarySql, values),
            filter.orgId,
          )
        : await this.#pool.query(summarySql, values);
    const summary: UsageSummary = {
      downloads: 0,
      explicit_installs: 0,
      retrieve_calls: 0,
      check_calls: 0,
      false_positive_reports: 0,
    };
    for (const row of result.rows) {
      const count = safeInteger(row.count);
      if (row.kind === "download") summary.downloads = count;
      if (row.kind === "install") summary.explicit_installs = count;
      if (row.kind === "retrieve") summary.retrieve_calls = count;
      if (row.kind === "check") summary.check_calls = count;
      if (row.kind === "false_positive") summary.false_positive_reports = count;
    }
    return summary;
  }
}

export class PostgresRegistryEntitlementService
  implements EntitlementServicePort
{
  readonly #pool: RegistrySqlPool;
  readonly billingMode: "off" | "enforced";

  constructor(
    pool: RegistrySqlPool,
    billingMode: "off" | "enforced" = "off",
  ) {
    this.#pool = pool;
    this.billingMode = billingMode;
  }

  async planFor(orgId: string): Promise<Plan> {
    if (this.billingMode === "off") return "enterprise";
    return withTransaction(
      this.#pool,
      (connection) => readPlan(connection, orgId),
      orgId,
    );
  }

  async entitlementsFor(orgId: string): Promise<PlanEntitlements> {
    return entitlementsForPlan(await this.planFor(orgId));
  }

  async assertSeats(orgId: string, seatCount: number): Promise<void> {
    if (!Number.isInteger(seatCount) || seatCount < 0) {
      throw new Error("seat count is invalid");
    }
    const maximum = (await this.entitlementsFor(orgId)).maxSeats;
    if (maximum !== null && seatCount > maximum) {
      throw new SeatLimitExceededError();
    }
  }

  async consume(
    orgId: string,
    amount: number,
    options: { idempotencyKey: string; occurredAt: string },
  ): Promise<{ used: number; duplicate: boolean }> {
    return withTransaction(
      this.#pool,
      (connection) =>
        reserveQuota(
          connection,
          this.billingMode,
          orgId,
          amount,
          options.idempotencyKey,
          options.occurredAt,
        ),
      orgId,
    );
  }
}

export class PostgresBillingWebhookHandler
  implements BillingWebhookHandlerPort
{
  readonly #pool: RegistrySqlPool;
  readonly #provider: string;
  readonly #secret: string;
  readonly #toleranceSeconds: number;

  constructor(
    pool: RegistrySqlPool,
    provider: string,
    secret: string,
    toleranceSeconds = 300,
  ) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
      throw new Error("Billing provider id is invalid");
    }
    if (secret.length < 16) throw new Error("billing webhook secret is too short");
    if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 3_600) {
      throw new Error("Billing webhook tolerance is invalid");
    }
    this.#pool = pool;
    this.#provider = provider;
    this.#secret = secret;
    this.#toleranceSeconds = toleranceSeconds;
  }

  async handle(
    body: string,
    signatureHeader: string,
    now = new Date(),
  ): Promise<{ event: BillingWebhookEvent; created: boolean; applied: boolean }> {
    verifyBillingWebhookSignature(
      body,
      signatureHeader,
      this.#secret,
      now,
      this.#toleranceSeconds,
    );
    const event = parseBillingWebhookEvent(body);
    const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
    return withTransaction(this.#pool, async (connection) => {
      // Tenant context is already set to event.org_id by withTransaction; the
      // organization existence check below reads a non-RLS global table.
      const organization = await connection.query(
        "SELECT id FROM registry_organizations WHERE id = $1 FOR UPDATE",
        [event.org_id],
      );
      if (organization.rows.length === 0) {
        throw new BillingWebhookRejectedError("billing organization not found");
      }
      const existing = await connection.query(
        `SELECT payload_hash, provider
           FROM registry_billing_webhook_events
          WHERE event_id = $1`,
        [event.event_id],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].payload_hash !== payloadHash ||
          existing.rows[0].provider !== this.#provider
        ) {
          throw new BillingWebhookRejectedError(
            "billing event id reused with different data",
          );
        }
        return { event, created: false, applied: false };
      }
      const current = await connection.query(
        `SELECT provider_event_created_at, provider_event_id
           FROM registry_subscriptions
          WHERE org_id = $1`,
        [event.org_id],
      );
      const latest = current.rows[0];
      const applied =
        !latest ||
        isBillingEventNewer(event, {
          created_at: timestamp(latest.provider_event_created_at),
          event_id:
            typeof latest.provider_event_id === "string"
              ? latest.provider_event_id
              : "",
        });
      const claimId = randomUUID();
      await connection.query(
        `INSERT INTO registry_billing_webhook_events
           (event_id, claim_id, payload_hash, provider_created_at, applied, received_at,
            org_id, provider, event_type)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6::timestamptz, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.event_id,
          claimId,
          payloadHash,
          event.created_at,
          applied,
          now.toISOString(),
          event.org_id,
          this.#provider,
          event.type,
        ],
      );
      const claimed = await connection.query(
        `SELECT claim_id, payload_hash, provider
           FROM registry_billing_webhook_events
          WHERE event_id = $1`,
        [event.event_id],
      );
      const stored = claimed.rows[0];
      if (
        !stored ||
        stored.payload_hash !== payloadHash ||
        stored.provider !== this.#provider
      ) {
        throw new BillingWebhookRejectedError(
          "billing event id reused with different data",
        );
      }
      if (stored.claim_id !== claimId) {
        return { event, created: false, applied: false };
      }
      if (applied) {
        const plan =
          event.type === "subscription.canceled" || event.status === "canceled"
            ? "free"
            : event.plan;
        await connection.query(
          `INSERT INTO registry_subscriptions
             (org_id, provider, plan, status, provider_event_created_at,
              provider_event_id, updated_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz)
           ON CONFLICT (org_id) DO UPDATE
             SET provider = EXCLUDED.provider,
                 plan = EXCLUDED.plan,
                 status = EXCLUDED.status,
                 provider_event_created_at = EXCLUDED.provider_event_created_at,
                 provider_event_id = EXCLUDED.provider_event_id,
                 updated_at = EXCLUDED.updated_at`,
          [
            event.org_id,
            this.#provider,
            plan,
            event.status,
            event.created_at,
            event.event_id,
            now.toISOString(),
          ],
        );
      }
      return { event, created: true, applied };
    }, event.org_id);
  }
}

async function recordUsageEvent(
  connection: RegistrySqlExecutor,
  event: UsageEvent,
): Promise<UsageRecordResult> {
  const existing = await findUsageEvent(
    connection,
    event.org_id,
    event.event_id,
  );
  if (existing) {
    if (!sameUsageEvent(existing, event)) throw new UsageConflictError();
    return { event: existing, created: false };
  }
  return insertUsageEvent(connection, event);
}

async function insertUsageEvent(
  connection: RegistrySqlExecutor,
  event: UsageEvent,
): Promise<UsageRecordResult> {
  const inserted = await connection.query(
    `INSERT INTO registry_usage_events
       (event_id, org_id, kind, consent, package_name, package_version,
        lesson_id, outcome, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (org_id, event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.event_id,
      event.org_id,
      event.kind,
      event.consent,
      event.package_name,
      event.package_version,
      event.lesson_id,
      event.outcome,
      event.occurred_at,
    ],
  );
  if (inserted.rows.length > 0) return { event, created: true };
  const existing = await findUsageEvent(connection, event.org_id, event.event_id);
  if (!existing || !sameUsageEvent(existing, event)) {
    throw new UsageConflictError();
  }
  return { event: existing, created: false };
}

async function findUsageEvent(
  connection: RegistrySqlExecutor,
  orgId: string,
  eventId: string,
): Promise<UsageEvent | null> {
  const result = await connection.query(
    `SELECT event_id, org_id, kind, consent, package_name, package_version,
            lesson_id, outcome, occurred_at
       FROM registry_usage_events
      WHERE org_id = $1 AND event_id = $2`,
    [orgId, eventId],
  );
  const row = result.rows[0];
  return row
    ? UsageEventSchema.parse({
        event_id: row.event_id,
        org_id: row.org_id,
        kind: row.kind,
        consent: row.consent,
        package_name: row.package_name,
        package_version: row.package_version,
        lesson_id: row.lesson_id,
        outcome: row.outcome,
        occurred_at: timestamp(row.occurred_at),
      })
    : null;
}

async function reserveQuota(
  connection: RegistrySqlExecutor,
  billingMode: "off" | "enforced",
  orgId: string,
  amount: number,
  eventId: string,
  occurredAt: string,
): Promise<{ used: number; duplicate: boolean }> {
  if (!Number.isInteger(amount) || amount < 1) throw new Error("usage amount is invalid");
  const period = periodStart(occurredAt);
  const organization = await connection.query(
    "SELECT id FROM registry_organizations WHERE id = $1 FOR UPDATE",
    [orgId],
  );
  if (organization.rows.length === 0) throw new Error("usage organization not found");
  const existing = await findReservation(connection, orgId, eventId, period);
  const used = await usedInPeriod(connection, orgId, period);
  if (existing) {
    if (
      existing.org_id !== orgId ||
      !existing.same_period ||
      existing.amount !== amount
    ) {
      throw new UsageConflictError();
    }
    return { used, duplicate: true };
  }
  const plan = billingMode === "off" ? "enterprise" : await readPlan(connection, orgId);
  const maximum = entitlementsForPlan(plan).monthlyEvents;
  if (maximum !== null && used + amount > maximum) {
    throw new UsageQuotaExceededError();
  }
  const claimId = randomUUID();
  await connection.query(
    `INSERT INTO registry_usage_reservations
       (event_id, org_id, period_start, amount, claim_id, created_at)
     VALUES ($1, $2, $3::date, $4, $5, $6::timestamptz)
     ON CONFLICT (org_id, event_id) DO NOTHING`,
    [eventId, orgId, period, amount, claimId, occurredAt],
  );
  const reservation = await findReservation(connection, orgId, eventId, period);
  if (
    !reservation ||
    !reservation.same_period ||
    reservation.amount !== amount
  ) {
    throw new UsageConflictError();
  }
  if (reservation.claim_id !== claimId) {
    return {
      used: await usedInPeriod(connection, orgId, period),
      duplicate: true,
    };
  }
  return { used: used + amount, duplicate: false };
}

async function findReservation(
  connection: RegistrySqlExecutor,
  orgId: string,
  eventId: string,
  period: string,
) {
  const result = await connection.query(
    `SELECT org_id, period_start = $3::date AS same_period, amount, claim_id
       FROM registry_usage_reservations
      WHERE org_id = $1 AND event_id = $2`,
    [orgId, eventId, period],
  );
  const row = result.rows[0];
  return row
    ? {
        org_id: String(row.org_id),
        same_period: row.same_period === true,
        amount: safeInteger(row.amount),
        claim_id: String(row.claim_id),
      }
    : null;
}

async function usedInPeriod(
  connection: RegistrySqlExecutor,
  orgId: string,
  period: string,
): Promise<number> {
  const result = await connection.query(
    `SELECT COALESCE(sum(amount), 0)::integer AS used
       FROM registry_usage_reservations
      WHERE org_id = $1 AND period_start = $2::date`,
    [orgId, period],
  );
  return safeInteger(result.rows[0]?.used ?? 0);
}

async function readPlan(
  connection: RegistrySqlExecutor,
  orgId: string,
): Promise<Plan> {
  const result = await connection.query(
    `SELECT plan, status
       FROM registry_subscriptions
      WHERE org_id = $1`,
    [orgId],
  );
  const row = result.rows[0];
  if (!row || row.status === "canceled") return "free";
  return PlanSchema.parse(row.plan);
}

async function withTransaction<T>(
  pool: RegistrySqlPool,
  operation: (connection: RegistrySqlConnection) => Promise<T>,
  tenantId?: string,
): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    if (tenantId !== undefined) {
      // Row-level security tenant context; SET LOCAL semantics via set_config
      // keep the value transaction-scoped and fully parameterized.
      await connection.query(
        "SELECT set_config('pitlore.tenant_id', $1, true)",
        [tenantId],
      );
    }
    const result = await operation(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Registry telemetry transaction and rollback both failed",
      );
    }
    throw error;
  } finally {
    connection.release();
  }
}

function sameUsageEvent(left: UsageEvent, right: UsageEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function periodStart(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("usage timestamp is invalid");
  return `${date.toISOString().slice(0, 7)}-01`;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("database timestamp is invalid");
  return date.toISOString();
}

function safeInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("database count is invalid");
  }
  return number;
}
