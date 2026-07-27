import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PackNameSchema, SemverSchema } from "./schema.js";

const RegistryIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const UsageEventSchema = z
  .object({
    event_id: RegistryIdSchema,
    occurred_at: z
      .string()
      .datetime()
      .transform((value) => new Date(value).toISOString()),
    kind: z.enum(["download", "install", "retrieve", "check", "false_positive"]),
    consent: z.enum(["server-observed-download", "client-opt-in"]),
    package_name: PackNameSchema,
    package_version: SemverSchema,
    org_id: RegistryIdSchema,
    lesson_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .nullable()
      .default(null),
    outcome: z.enum(["hit", "clean", "used", "irrelevant"]).nullable().default(null),
  })
  .strict()
  .superRefine((event, context) => {
    const expected =
      event.kind === "download" ? "server-observed-download" : "client-opt-in";
    if (event.consent !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consent"],
        message: `${event.kind} requires ${expected}`,
      });
    }
    refineUsageEventSemantics(event, context);
  });

export function refineUsageEventSemantics(
  event: {
    readonly kind: "download" | "install" | "retrieve" | "check" | "false_positive";
    readonly lesson_id: string | null;
    readonly outcome: "hit" | "clean" | "used" | "irrelevant" | null;
  },
  context: z.RefinementCtx,
): void {
  const issue = (path: "lesson_id" | "outcome", message: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (event.kind === "download" || event.kind === "install") {
    if (event.lesson_id !== null) {
      issue("lesson_id", `${event.kind} usage must not identify a Lesson`);
    }
    if (event.outcome !== null) {
      issue("outcome", `${event.kind} usage must not carry a retrieval/check outcome`);
    }
    return;
  }
  if (event.kind === "retrieve") {
    if (event.lesson_id === null && event.outcome !== null) {
      issue("outcome", "retrieve outcome requires a Lesson id");
    } else if (
      event.lesson_id !== null &&
      event.outcome !== "used" &&
      event.outcome !== "irrelevant"
    ) {
      issue("outcome", "retrieve Lesson feedback must be used or irrelevant");
    }
    return;
  }
  if (event.kind === "check") {
    const clean = event.lesson_id === null && event.outcome === "clean";
    const hit = event.lesson_id !== null && event.outcome === "hit";
    if (!clean && !hit) {
      issue("outcome", "check usage must be a clean scan or identify the hit Lesson");
    }
    return;
  }
  if (event.lesson_id === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lesson_id"],
        message: "false-positive feedback requires a Lesson id",
      });
  }
  if (event.outcome !== null) {
    issue("outcome", "false-positive feedback must not carry a separate outcome");
  }
}

export type UsageEvent = z.infer<typeof UsageEventSchema>;

export interface UsageSummary {
  downloads: number;
  explicit_installs: number;
  retrieve_calls: number;
  check_calls: number;
  false_positive_reports: number;
}

export interface UsageRecordResult {
  readonly event: UsageEvent;
  readonly created: boolean;
}

export class UsageQuotaExceededError extends Error {
  constructor() {
    super("Registry usage quota exceeded");
    this.name = "UsageQuotaExceededError";
  }
}

export class UsageConflictError extends Error {
  constructor() {
    super("Registry usage event conflicts with an existing event");
    this.name = "UsageConflictError";
  }
}

export class SeatLimitExceededError extends Error {
  constructor() {
    super("Registry organization seat limit exceeded");
    this.name = "SeatLimitExceededError";
  }
}

export interface UsageLedgerPort {
  record(input: unknown): UsageRecordResult | Promise<UsageRecordResult>;
  summary(
    filter?: { packageName?: string; orgId?: string | null },
  ): UsageSummary | Promise<UsageSummary>;
  recordWithQuota?: (
    input: unknown,
  ) =>
    | (UsageRecordResult & { quota: { used: number; duplicate: boolean } })
    | Promise<UsageRecordResult & { quota: { used: number; duplicate: boolean } }>;
}

export class UsageLedger {
  readonly #events = new Map<string, UsageEvent>();

  record(input: unknown): { event: UsageEvent; created: boolean } {
    const event = UsageEventSchema.parse(input);
    const key = `${event.org_id}:${event.event_id}`;
    const existing = this.#events.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new UsageConflictError();
      }
      return { event: existing, created: false };
    }
    this.#events.set(key, Object.freeze(event));
    return { event, created: true };
  }

  summary(filter: { packageName?: string; orgId?: string | null } = {}): UsageSummary {
    const result: UsageSummary = {
      downloads: 0,
      explicit_installs: 0,
      retrieve_calls: 0,
      check_calls: 0,
      false_positive_reports: 0,
    };
    for (const event of this.#events.values()) {
      if (filter.packageName && event.package_name !== filter.packageName) continue;
      if (filter.orgId !== undefined && event.org_id !== filter.orgId) continue;
      if (event.kind === "download") result.downloads += 1;
      if (event.kind === "install") result.explicit_installs += 1;
      if (event.kind === "retrieve") result.retrieve_calls += 1;
      if (event.kind === "check") result.check_calls += 1;
      if (event.kind === "false_positive") result.false_positive_reports += 1;
    }
    return result;
  }

  list(): readonly UsageEvent[] {
    return [...this.#events.values()];
  }
}

export const PlanSchema = z.enum(["free", "team", "enterprise"]);
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanEntitlements {
  maxSeats: number | null;
  monthlyEvents: number | null;
  privatePacks: boolean;
  releaseApprovals: boolean;
}

const PLAN_ENTITLEMENTS: Record<Plan, PlanEntitlements> = {
  free: {
    maxSeats: 3,
    monthlyEvents: 1_000,
    privatePacks: false,
    releaseApprovals: true,
  },
  team: {
    maxSeats: 25,
    monthlyEvents: 100_000,
    privatePacks: true,
    releaseApprovals: true,
  },
  enterprise: {
    maxSeats: null,
    monthlyEvents: null,
    privatePacks: true,
    releaseApprovals: true,
  },
};

export function entitlementsForPlan(plan: Plan): PlanEntitlements {
  return { ...PLAN_ENTITLEMENTS[PlanSchema.parse(plan)] };
}

export class EntitlementService {
  readonly #plans = new Map<string, Plan>();
  readonly #usage = new Map<string, number>();
  readonly #idempotency = new Map<
    string,
    { readonly period: string; readonly amount: number }
  >();

  constructor(readonly billingMode: "off" | "enforced" = "off") {}

  setPlan(orgId: string, plan: Plan): void {
    RegistryIdSchema.parse(orgId);
    this.#plans.set(orgId, PlanSchema.parse(plan));
  }

  planFor(orgId: string): Plan {
    RegistryIdSchema.parse(orgId);
    if (this.billingMode === "off") return "enterprise";
    return this.#plans.get(orgId) ?? "free";
  }

  entitlementsFor(orgId: string): PlanEntitlements {
    return entitlementsForPlan(this.planFor(orgId));
  }

  assertSeats(orgId: string, seatCount: number): void {
    if (!Number.isInteger(seatCount) || seatCount < 0) throw new Error("seat count is invalid");
    const maximum = this.entitlementsFor(orgId).maxSeats;
    if (maximum !== null && seatCount > maximum) {
      throw new SeatLimitExceededError();
    }
  }

  consume(
    orgId: string,
    amount: number,
    options: { idempotencyKey: string; occurredAt: string },
  ): { used: number; duplicate: boolean } {
    RegistryIdSchema.parse(orgId);
    RegistryIdSchema.parse(options.idempotencyKey);
    if (!Number.isInteger(amount) || amount < 1) throw new Error("usage amount is invalid");
    const period = new Date(z.string().datetime().parse(options.occurredAt))
      .toISOString()
      .slice(0, 7);
    // A key is durable per organization. Reusing it for another period or
    // amount is ambiguous and must not create a second quota reservation.
    const idempotency = JSON.stringify([orgId, options.idempotencyKey]);
    const counter = `${orgId}:${period}`;
    const current = this.#usage.get(counter) ?? 0;
    const existing = this.#idempotency.get(idempotency);
    if (existing) {
      if (existing.period !== period || existing.amount !== amount) {
        throw new UsageConflictError();
      }
      return { used: current, duplicate: true };
    }
    const next = current + amount;
    const maximum = this.entitlementsFor(orgId).monthlyEvents;
    if (maximum !== null && next > maximum) {
      throw new UsageQuotaExceededError();
    }
    this.#usage.set(counter, next);
    this.#idempotency.set(idempotency, { period, amount });
    return { used: next, duplicate: false };
  }
}

export interface EntitlementServicePort {
  readonly billingMode: "off" | "enforced";
  planFor(orgId: string): Plan | Promise<Plan>;
  entitlementsFor(orgId: string): PlanEntitlements | Promise<PlanEntitlements>;
  assertSeats(orgId: string, seatCount: number): void | Promise<void>;
  consume(
    orgId: string,
    amount: number,
    options: { idempotencyKey: string; occurredAt: string },
  ):
    | { used: number; duplicate: boolean }
    | Promise<{ used: number; duplicate: boolean }>;
}

export interface BillingProvider {
  createCheckout(orgId: string, plan: Exclude<Plan, "free">): Promise<{ url: string }>;
  createPortal(orgId: string): Promise<{ url: string }>;
}

export class BillingUnavailableError extends Error {
  constructor() {
    super("Registry billing provider is not configured");
    this.name = "BillingUnavailableError";
  }
}

export class BillingWebhookRejectedError extends Error {
  constructor(message = "Registry billing webhook was rejected") {
    super(message);
    this.name = "BillingWebhookRejectedError";
  }
}

/** Production-safe default: self-hosted deployments never emit fake payment URLs. */
export class UnavailableBillingProvider implements BillingProvider {
  async createCheckout(
    _orgId: string,
    _plan: Exclude<Plan, "free">,
  ): Promise<{ url: string }> {
    throw new BillingUnavailableError();
  }

  async createPortal(_orgId: string): Promise<{ url: string }> {
    throw new BillingUnavailableError();
  }
}

export class FakeBillingProvider implements BillingProvider {
  async createCheckout(
    orgId: string,
    plan: Exclude<Plan, "free">,
  ): Promise<{ url: string }> {
    RegistryIdSchema.parse(orgId);
    if (!(["team", "enterprise"] as string[]).includes(plan)) {
      throw new Error("checkout plan is invalid");
    }
    return { url: `https://billing.invalid/checkout/${orgId}/${plan}` };
  }

  async createPortal(orgId: string): Promise<{ url: string }> {
    RegistryIdSchema.parse(orgId);
    return { url: `https://billing.invalid/portal/${orgId}` };
  }
}

export const BillingWebhookEventSchema = z
  .object({
    event_id: RegistryIdSchema,
    created_at: z.string().datetime(),
    org_id: RegistryIdSchema,
    type: z.enum(["subscription.updated", "subscription.canceled"]),
    plan: PlanSchema,
    status: z.enum(["active", "past_due", "canceled"]),
  })
  .strict();

export type BillingWebhookEvent = z.infer<typeof BillingWebhookEventSchema>;

export function isBillingEventNewer(
  event: Pick<BillingWebhookEvent, "created_at" | "event_id">,
  current: Pick<BillingWebhookEvent, "created_at" | "event_id">,
): boolean {
  const eventTime = Date.parse(event.created_at);
  const currentTime = Date.parse(current.created_at);
  if (!Number.isFinite(eventTime) || !Number.isFinite(currentTime)) {
    throw new BillingWebhookRejectedError(
      "billing event ordering timestamp is invalid",
    );
  }
  if (eventTime !== currentTime) return eventTime > currentTime;
  // Provider timestamps can collide at their advertised resolution. The
  // stable event id tie-break keeps delivery order from selecting the plan.
  return event.event_id > current.event_id;
}

export class BillingWebhookHandler {
  readonly #seen = new Map<string, string>();
  readonly #latest = new Map<
    string,
    Pick<BillingWebhookEvent, "created_at" | "event_id">
  >();

  constructor(
    private readonly secret: string,
    private readonly entitlements: EntitlementService,
    private readonly toleranceSeconds = 300,
  ) {
    if (secret.length < 16) throw new Error("billing webhook secret is too short");
  }

  handle(
    body: string,
    signatureHeader: string,
    now = new Date(),
  ): { event: BillingWebhookEvent; created: boolean; applied: boolean } {
    verifyBillingWebhookSignature(
      body,
      signatureHeader,
      this.secret,
      now,
      this.toleranceSeconds,
    );
    const event = parseBillingWebhookEvent(body);
    const canonical = JSON.stringify(event);
    const existing = this.#seen.get(event.event_id);
    if (existing) {
      if (existing !== canonical) {
        throw new BillingWebhookRejectedError(
          `billing event id reused with different data: ${event.event_id}`,
        );
      }
      return { event, created: false, applied: false };
    }
    this.#seen.set(event.event_id, canonical);

    const latest = this.#latest.get(event.org_id);
    if (latest && !isBillingEventNewer(event, latest)) {
      return { event, created: true, applied: false };
    }
    this.#latest.set(event.org_id, {
      created_at: event.created_at,
      event_id: event.event_id,
    });
    const plan =
      event.type === "subscription.canceled" || event.status === "canceled"
        ? "free"
        : event.plan;
    this.entitlements.setPlan(event.org_id, plan);
    return { event, created: true, applied: true };
  }
}

export interface BillingWebhookHandlerPort {
  handle(
    body: string,
    signatureHeader: string,
    now?: Date,
  ):
    | { event: BillingWebhookEvent; created: boolean; applied: boolean }
    | Promise<{ event: BillingWebhookEvent; created: boolean; applied: boolean }>;
}

export function signWebhook(body: string, secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyBillingWebhookSignature(
  body: string,
  header: string,
  secret: string,
  now: Date,
  toleranceSeconds: number,
): void {
  const values = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=", 2);
      return [key, value];
    }),
  );
  const timestamp = Number(values.t);
  const signature = values.v1;
  if (!Number.isInteger(timestamp) || !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new BillingWebhookRejectedError("billing webhook signature header is invalid");
  }
  if (Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > toleranceSeconds) {
    throw new BillingWebhookRejectedError(
      "billing webhook timestamp is outside the replay window",
    );
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  const actualBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new BillingWebhookRejectedError(
      "billing webhook signature verification failed",
    );
  }
}

export function parseBillingWebhookEvent(body: string): BillingWebhookEvent {
  try {
    return BillingWebhookEventSchema.parse(JSON.parse(body));
  } catch (error) {
    if (error instanceof BillingWebhookRejectedError) throw error;
    throw new BillingWebhookRejectedError("billing webhook payload is invalid");
  }
}
