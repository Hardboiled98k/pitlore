import { DataType, newDb } from "pg-mem";
import { enablePgMemRlsCompat } from "./helpers/pg-mem-rls.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRegistryMigrations,
  PostgresRegistryRepository,
  type RegistrySqlPool,
} from "../src/registry-postgres.js";
import {
  PostgresBillingWebhookHandler,
  PostgresRegistryEntitlementService,
  PostgresRegistryUsageLedger,
} from "../src/registry-postgres-telemetry.js";
import {
  UsageConflictError,
  UsageQuotaExceededError,
  signWebhook,
} from "../src/registry-telemetry.js";

const NOW = new Date("2026-07-16T18:00:00.000Z");
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_ORG_ID = "10000000-0000-4000-8000-000000000002";
const SECOND_USER_ID = "20000000-0000-4000-8000-000000000002";
const SECRET = "persistent-webhook-secret-32-bytes";
const pools: Array<RegistrySqlPool & { end(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("PostgreSQL Registry telemetry", () => {
  it("keeps release approval safety enabled for the free plan", async () => {
    const pool = await setup();
    const entitlements = new PostgresRegistryEntitlementService(pool, "enforced");

    await expect(entitlements.planFor(ORG_ID)).resolves.toBe("free");
    await expect(entitlements.entitlementsFor(ORG_ID)).resolves.toMatchObject({
      privatePacks: false,
      releaseApprovals: true,
    });
  });

  it("persists idempotent privacy-safe usage and enforces transactional quotas", async () => {
    const pool = await setup();
    const ledger = new PostgresRegistryUsageLedger(
      pool,
      "enforced",
      () => new Date(NOW),
    );
    const event = usageEvent("usage-1");
    await expect(ledger.recordWithQuota(event)).resolves.toMatchObject({
      created: true,
      quota: { used: 1, duplicate: false },
    });
    await expect(ledger.recordWithQuota(event)).resolves.toMatchObject({
      created: false,
      quota: { used: 1, duplicate: true },
    });
    await expect(
      ledger.recordWithQuota({
        ...usageEvent("canonical-time"),
        occurred_at: "2026-07-16T18:00:00Z",
      }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      ledger.recordWithQuota({
        ...usageEvent("canonical-time"),
        occurred_at: "2026-07-16T18:00:00.000Z",
      }),
    ).resolves.toMatchObject({ created: false, quota: { duplicate: true } });

    const concurrent = await Promise.all([
      ledger.recordWithQuota(usageEvent("concurrent-same-event")),
      ledger.recordWithQuota(usageEvent("concurrent-same-event")),
    ]);
    expect(concurrent.map((result) => result.created).sort()).toEqual([false, true]);
    expect(concurrent.map((result) => result.quota.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      ledger.recordWithQuota({ ...event, outcome: "irrelevant" }),
    ).rejects.toBeInstanceOf(UsageConflictError);

    const repository = new PostgresRegistryRepository(pool);
    await repository.insertUser({
      id: SECOND_USER_ID,
      issuer: "test",
      subject: "second-owner",
      display_name: "Second owner",
      created_at: NOW.toISOString(),
    });
    await repository.createOrganization({
      id: SECOND_ORG_ID,
      slug: "beta",
      name: "Beta",
      owner_user_id: SECOND_USER_ID,
      created_at: NOW.toISOString(),
    });
    await expect(
      ledger.recordWithQuota({ ...event, org_id: SECOND_ORG_ID }),
    ).resolves.toMatchObject({ created: true, quota: { used: 1 } });

    await expect(
      ledger.recordWithQuota({
        ...usageEvent("historical-client-time"),
        occurred_at: "2020-01-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ quota: { used: 4 } });
    const reservation = await pool.query(
      `SELECT period_start
         FROM registry_usage_reservations
        WHERE org_id = $1 AND event_id = $2`,
      [ORG_ID, "historical-client-time"],
    );
    expect(new Date(reservation.rows[0]?.period_start as string).toISOString().slice(0, 10))
      .toBe("2026-07-01");

    await ledger.record({
      ...usageEvent("download-1"),
      kind: "download",
      consent: "server-observed-download",
      lesson_id: null,
      outcome: null,
    });
    const restarted = new PostgresRegistryUsageLedger(
      pool,
      "enforced",
      () => new Date(NOW),
    );
    await expect(
      restarted.summary({ orgId: ORG_ID, packageName: "acme/core" }),
    ).resolves.toEqual({
      downloads: 1,
      explicit_installs: 0,
      retrieve_calls: 4,
      check_calls: 0,
      false_positive_reports: 0,
    });

    const entitlements = new PostgresRegistryEntitlementService(pool, "enforced");
    await expect(
      entitlements.consume(ORG_ID, 1_001, {
        idempotencyKey: "too-many",
        occurredAt: NOW.toISOString(),
      }),
    ).rejects.toBeInstanceOf(UsageQuotaExceededError);
  });

  it("treats quota idempotency keys as durable per organization across months", async () => {
    const pool = await setup();
    const entitlements = new PostgresRegistryEntitlementService(pool, "enforced");
    const july = {
      idempotencyKey: "durable-batch",
      occurredAt: "2026-07-16T00:00:00.000Z",
    };

    await expect(entitlements.consume(ORG_ID, 100, july)).resolves.toEqual({
      used: 100,
      duplicate: false,
    });
    await expect(entitlements.consume(ORG_ID, 100, july)).resolves.toEqual({
      used: 100,
      duplicate: true,
    });
    await expect(
      entitlements.consume(ORG_ID, 99, july),
    ).rejects.toBeInstanceOf(UsageConflictError);
    await expect(
      entitlements.consume(ORG_ID, 100, {
        ...july,
        occurredAt: "2026-08-16T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UsageConflictError);
    await expect(
      entitlements.consume(ORG_ID, 1_000, {
        idempotencyKey: "august-batch",
        occurredAt: "2026-08-16T00:00:00.000Z",
      }),
    ).resolves.toEqual({ used: 1_000, duplicate: false });
  });

  it("persists signed, replay-safe, deterministic out-of-order billing updates", async () => {
    const pool = await setup();
    const handler = new PostgresBillingWebhookHandler(
      pool,
      "test-provider",
      SECRET,
    );
    const team = billingEvent("billing-2", "2026-07-16T18:00:00.000Z", "team", "active");
    await expect(handle(handler, team)).resolves.toMatchObject({
      created: true,
      applied: true,
    });
    await expect(handle(handler, team)).resolves.toMatchObject({
      created: false,
      applied: false,
    });
    const concurrentEvent = billingEvent(
      "billing-concurrent",
      "2026-07-16T18:30:00.000Z",
      "team",
      "active",
    );
    const concurrent = await Promise.all([
      handle(handler, concurrentEvent),
      handle(handler, concurrentEvent),
    ]);
    expect(concurrent.map((result) => result.created).sort()).toEqual([false, true]);
    expect(concurrent.filter((result) => result.applied)).toHaveLength(1);
    const older = billingEvent(
      "billing-1",
      "2026-07-16T17:00:00.000Z",
      "free",
      "canceled",
      "subscription.canceled",
    );
    await expect(handle(handler, older)).resolves.toMatchObject({
      created: true,
      applied: false,
    });
    const entitlements = new PostgresRegistryEntitlementService(pool, "enforced");
    await expect(entitlements.planFor(ORG_ID)).resolves.toBe("team");

    const canceled = billingEvent(
      "billing-3",
      "2026-07-16T19:00:00.000Z",
      "team",
      "canceled",
      "subscription.canceled",
    );
    const restarted = new PostgresBillingWebhookHandler(
      pool,
      "test-provider",
      SECRET,
    );
    await expect(handle(restarted, canceled)).resolves.toMatchObject({ applied: true });
    await expect(entitlements.planFor(ORG_ID)).resolves.toBe("free");
  });

  it("orders equal-timestamp billing events by event id regardless of delivery order", async () => {
    const lower = billingEvent(
      "billing-tie-a",
      NOW.toISOString(),
      "free",
      "canceled",
      "subscription.canceled",
    );
    const higher = billingEvent(
      "billing-tie-z",
      NOW.toISOString(),
      "team",
      "active",
    );

    const firstPool = await setup();
    const first = new PostgresBillingWebhookHandler(
      firstPool,
      "test-provider",
      SECRET,
    );
    await expect(handle(first, lower)).resolves.toMatchObject({
      created: true,
      applied: true,
    });
    await expect(handle(first, higher)).resolves.toMatchObject({
      created: true,
      applied: true,
    });
    const firstEntitlements = new PostgresRegistryEntitlementService(
      firstPool,
      "enforced",
    );
    await expect(firstEntitlements.planFor(ORG_ID)).resolves.toBe("team");

    const secondPool = await setup();
    const second = new PostgresBillingWebhookHandler(
      secondPool,
      "test-provider",
      SECRET,
    );
    await expect(handle(second, higher)).resolves.toMatchObject({
      created: true,
      applied: true,
    });
    await expect(handle(second, lower)).resolves.toMatchObject({
      created: true,
      applied: false,
    });
    const secondEntitlements = new PostgresRegistryEntitlementService(
      secondPool,
      "enforced",
    );
    await expect(secondEntitlements.planFor(ORG_ID)).resolves.toBe("team");
  });
});

async function setup() {
  const database = newDb();
  enablePgMemRlsCompat(database);
  registerMigrationAdvisoryLocks(database);
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
  pools.push(pool);
  await applyRegistryMigrations(pool);
  const repository = new PostgresRegistryRepository(pool);
  await repository.insertUser({
    id: USER_ID,
    issuer: "test",
    subject: "owner",
    display_name: "Owner",
    created_at: NOW.toISOString(),
  });
  await repository.createOrganization({
    id: ORG_ID,
    slug: "acme",
    name: "Acme",
    owner_user_id: USER_ID,
    created_at: NOW.toISOString(),
  });
  return pool;
}

function registerMigrationAdvisoryLocks(database: ReturnType<typeof newDb>): void {
  database.public.registerFunction({
    name: "pg_advisory_lock",
    args: [DataType.integer, DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
  database.public.registerFunction({
    name: "pg_advisory_unlock",
    args: [DataType.integer, DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
}

function usageEvent(eventId: string) {
  return {
    event_id: eventId,
    occurred_at: NOW.toISOString(),
    kind: "retrieve" as const,
    consent: "client-opt-in" as const,
    package_name: "acme/core",
    package_version: "1.0.0",
    org_id: ORG_ID,
    lesson_id: "tenant-filter",
    outcome: "used" as const,
  };
}

function billingEvent(
  eventId: string,
  createdAt: string,
  plan: "free" | "team" | "enterprise",
  status: "active" | "past_due" | "canceled",
  type: "subscription.updated" | "subscription.canceled" = "subscription.updated",
) {
  return {
    event_id: eventId,
    created_at: createdAt,
    org_id: ORG_ID,
    type,
    plan,
    status,
  };
}

function handle(
  handler: PostgresBillingWebhookHandler,
  event: ReturnType<typeof billingEvent>,
) {
  const raw = JSON.stringify(event);
  return handler.handle(
    raw,
    signWebhook(raw, SECRET, Math.floor(NOW.getTime() / 1_000)),
    NOW,
  );
}
