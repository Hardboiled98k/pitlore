import { describe, expect, it } from "vitest";
import {
  BillingWebhookHandler,
  EntitlementService,
  FakeBillingProvider,
  UnavailableBillingProvider,
  UsageConflictError,
  UsageLedger,
  signWebhook,
} from "../src/registry-telemetry.js";

describe("Registry privacy-safe telemetry", () => {
  it("separates server downloads from explicit client usage and deduplicates events", () => {
    const ledger = new UsageLedger();
    const download = usage("download-1", "download", "server-observed-download");
    expect(ledger.record(download).created).toBe(true);
    expect(ledger.record(download).created).toBe(false);
    expect(ledger.record({ ...download, org_id: "org-b" }).created).toBe(true);
    ledger.record(usage("install-1", "install", "client-opt-in"));
    ledger.record(usage("retrieve-1", "retrieve", "client-opt-in"));
    ledger.record({
      ...usage("fp-1", "false_positive", "client-opt-in"),
      lesson_id: "http-timeout",
    });

    expect(ledger.summary()).toEqual({
      downloads: 2,
      explicit_installs: 1,
      retrieve_calls: 1,
      check_calls: 0,
      false_positive_reports: 1,
    });
    expect(() =>
      ledger.record({ ...download, kind: "install", consent: "client-opt-in" }),
    ).toThrow(UsageConflictError);
  });

  it("rejects implicit client tracking and any extra raw prompt/source/path/PII fields", () => {
    const ledger = new UsageLedger();
    expect(() =>
      ledger.record(usage("implicit", "retrieve", "server-observed-download")),
    ).toThrow("requires client-opt-in");
    for (const extra of [
      { raw_prompt: "private prompt" },
      { source: "const secret = true" },
      { file_path: "/Users/alice/project/file.ts" },
      { email: "person@example.com" },
    ]) {
      expect(() => ledger.record({ ...usage("unsafe", "check", "client-opt-in"), ...extra })).toThrow(
        /unrecognized/i,
      );
    }
    for (const invalid of [
      {
        ...usage("install-with-result", "install", "client-opt-in"),
        lesson_id: "http-timeout",
        outcome: "hit",
      },
      {
        ...usage("check-hit-without-lesson", "check", "client-opt-in"),
        outcome: "hit",
      },
      {
        ...usage("false-positive-with-result", "false_positive", "client-opt-in"),
        lesson_id: "http-timeout",
        outcome: "used",
      },
    ]) {
      expect(() => ledger.record(invalid)).toThrow();
    }
  });
});

describe("Registry entitlements and billing adapters", () => {
  it("enforces seats, monthly quota, and usage idempotency only in billing mode", () => {
    const enforced = new EntitlementService("enforced");
    expect(enforced.entitlementsFor("org-a")).toMatchObject({
      privatePacks: false,
      releaseApprovals: true,
    });
    enforced.assertSeats("org-a", 3);
    expect(() => enforced.assertSeats("org-a", 4)).toThrow("seat limit exceeded");
    const first = enforced.consume("org-a", 900, {
      idempotencyKey: "batch-1",
      occurredAt: "2026-07-16T00:00:00.000Z",
    });
    expect(first).toEqual({ used: 900, duplicate: false });
    expect(
      enforced.consume("org-a", 900, {
        idempotencyKey: "batch-1",
        occurredAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toEqual({ used: 900, duplicate: true });
    expect(() =>
      enforced.consume("org-a", 899, {
        idempotencyKey: "batch-1",
        occurredAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toThrow(UsageConflictError);
    expect(() =>
      enforced.consume("org-a", 900, {
        idempotencyKey: "batch-1",
        occurredAt: "2026-08-16T00:00:00.000Z",
      }),
    ).toThrow(UsageConflictError);
    expect(() =>
      enforced.consume("org-a", 101, {
        idempotencyKey: "batch-2",
        occurredAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toThrow("quota exceeded");
    expect(
      enforced.consume("org-a", 1_000, {
        idempotencyKey: "batch-august",
        occurredAt: "2026-08-16T00:00:00.000Z",
      }),
    ).toEqual({ used: 1_000, duplicate: false });

    const selfHosted = new EntitlementService("off");
    expect(selfHosted.planFor("org-a")).toBe("enterprise");
    selfHosted.assertSeats("org-a", 100_000);
  });

  it("uses an explicit fake provider without claiming real payment", async () => {
    const provider = new FakeBillingProvider();
    await expect(provider.createCheckout("org-a", "team")).resolves.toEqual({
      url: "https://billing.invalid/checkout/org-a/team",
    });
    await expect(provider.createPortal("org-a")).resolves.toEqual({
      url: "https://billing.invalid/portal/org-a",
    });
  });

  it("fails closed when no real billing provider adapter is configured", async () => {
    const provider = new UnavailableBillingProvider();
    await expect(provider.createCheckout("org-a", "team")).rejects.toThrow(
      "not configured",
    );
    await expect(provider.createPortal("org-a")).rejects.toThrow(
      "not configured",
    );
  });

  it("verifies webhook HMAC, rejects replay windows, and ignores older state", () => {
    const entitlements = new EntitlementService("enforced");
    const secret = "test-webhook-secret-at-least-16";
    const handler = new BillingWebhookHandler(secret, entitlements);
    const now = new Date("2026-07-16T10:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000);
    const active = JSON.stringify({
      event_id: "evt-active",
      created_at: "2026-07-16T09:59:59.000Z",
      org_id: "org-a",
      type: "subscription.updated",
      plan: "team",
      status: "active",
    });
    const signature = signWebhook(active, secret, timestamp);
    expect(handler.handle(active, signature, now)).toMatchObject({
      created: true,
      applied: true,
    });
    expect(entitlements.planFor("org-a")).toBe("team");
    expect(handler.handle(active, signature, now)).toMatchObject({
      created: false,
      applied: false,
    });

    const older = JSON.stringify({
      event_id: "evt-older",
      created_at: "2026-07-16T09:00:00.000Z",
      org_id: "org-a",
      type: "subscription.canceled",
      plan: "team",
      status: "canceled",
    });
    expect(handler.handle(older, signWebhook(older, secret, timestamp), now)).toMatchObject({
      created: true,
      applied: false,
    });
    expect(entitlements.planFor("org-a")).toBe("team");
    expect(() => handler.handle(active, signWebhook(active, "wrong-secret-value-123", timestamp), now)).toThrow(
      "verification failed",
    );
    expect(() => handler.handle(active, signWebhook(active, secret, timestamp - 1_000), now)).toThrow(
      "replay window",
    );
  });

  it("orders equal-timestamp billing events by event id regardless of delivery order", () => {
    const secret = "test-webhook-secret-at-least-16";
    const now = new Date("2026-07-16T10:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000);
    const lower = {
      event_id: "evt-tie-a",
      created_at: "2026-07-16T09:59:59.000Z",
      org_id: "org-a",
      type: "subscription.canceled",
      plan: "free",
      status: "canceled",
    };
    const higher = {
      event_id: "evt-tie-z",
      created_at: lower.created_at,
      org_id: "org-a",
      type: "subscription.updated",
      plan: "team",
      status: "active",
    };
    const deliver = (
      handler: BillingWebhookHandler,
      event: Record<string, unknown>,
    ) => {
      const body = JSON.stringify(event);
      return handler.handle(body, signWebhook(body, secret, timestamp), now);
    };

    const firstEntitlements = new EntitlementService("enforced");
    const first = new BillingWebhookHandler(secret, firstEntitlements);
    expect(deliver(first, lower)).toMatchObject({ created: true, applied: true });
    expect(deliver(first, higher)).toMatchObject({ created: true, applied: true });
    expect(firstEntitlements.planFor("org-a")).toBe("team");

    const secondEntitlements = new EntitlementService("enforced");
    const second = new BillingWebhookHandler(secret, secondEntitlements);
    expect(deliver(second, higher)).toMatchObject({ created: true, applied: true });
    expect(deliver(second, lower)).toMatchObject({ created: true, applied: false });
    expect(secondEntitlements.planFor("org-a")).toBe("team");
  });
});

function usage(
  eventId: string,
  kind: "download" | "install" | "retrieve" | "check" | "false_positive",
  consent: "server-observed-download" | "client-opt-in",
) {
  return {
    event_id: eventId,
    occurred_at: "2026-07-16T00:00:00.000Z",
    kind,
    consent,
    package_name: "pitlore/node-reliability",
    package_version: "1.0.0",
    org_id: "org-a",
    lesson_id: null,
    outcome: null,
  } as const;
}
