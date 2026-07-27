import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeterministicIdentityVerifier,
  REGISTRY_PERMISSIONS,
  ROLE_PERMISSIONS,
  RegistryAuthorizationError,
  assertTenantAuthorized,
  authenticateApiToken,
  createHumanActor,
  issueApiToken,
  revokeApiToken,
  type ApiTokenRecord,
  type RegistryActor,
  type RegistryAuthorizationErrorCode,
  type RegistryRole,
  type VerifiedIdentity,
} from "../src/registry-auth.js";

const NOW = new Date("2026-07-16T10:00:00.000Z");
const LATER = new Date("2026-07-16T11:00:00.000Z");
const IDENTITY: VerifiedIdentity = {
  provider: "test-oidc",
  issuer: "https://identity.example.com/",
  providerSubjectId: "provider|alice",
  subjectId: "user:alice",
  tenantId: "acme",
  verifiedAt: NOW.toISOString(),
};

describe("Phase 3 registry auth and RBAC", () => {
  it("defines an additive viewer/publisher/admin/owner permission matrix", () => {
    expect(ROLE_PERMISSIONS.viewer).toEqual(["pack:read"]);
    expect(ROLE_PERMISSIONS.publisher).toEqual([
      "pack:read",
      "pack:publish",
    ]);
    expect(ROLE_PERMISSIONS.admin).toEqual([
      "pack:read",
      "pack:publish",
      "pack:deprecate",
      "member:read",
      "member:manage",
      "token:issue",
      "token:revoke",
      "audit:read",
      "organization:update",
    ]);
    expect(ROLE_PERMISSIONS.owner).toEqual(REGISTRY_PERMISSIONS);

    const roles: RegistryRole[] = ["viewer", "publisher", "admin", "owner"];
    for (let index = 1; index < roles.length; index += 1) {
      const stronger = new Set(ROLE_PERMISSIONS[roles[index]!]);
      for (const permission of ROLE_PERMISSIONS[roles[index - 1]!]) {
        expect(stronger.has(permission)).toBe(true);
      }
    }
  });

  it("authorizes human roles and keeps owner-only actions owner-only", () => {
    const viewer = createHumanActor(IDENTITY, "viewer");
    const publisher = createHumanActor(IDENTITY, "publisher");
    const admin = createHumanActor(IDENTITY, "admin");
    const owner = createHumanActor(IDENTITY, "owner");

    expect(() => assertTenantAuthorized(viewer, "acme", "pack:read")).not.toThrow();
    expectAuthorizationError(
      () => assertTenantAuthorized(viewer, "acme", "pack:publish"),
      "permission_denied",
    );
    expectAuthorizationError(
      () => assertTenantAuthorized(publisher, "acme", "pack:deprecate"),
      "permission_denied",
    );
    expect(() =>
      assertTenantAuthorized(admin, "acme", "pack:deprecate"),
    ).not.toThrow();
    expect(() => assertTenantAuthorized(admin, "acme", "member:manage")).not.toThrow();
    expectAuthorizationError(
      () => assertTenantAuthorized(admin, "acme", "billing:manage"),
      "permission_denied",
    );
    expect(() =>
      assertTenantAuthorized(owner, "acme", "organization:transfer"),
    ).not.toThrow();
    expect(() => assertTenantAuthorized(owner, "acme", "billing:manage")).not.toThrow();
  });

  it("checks the exact tenant before permissions and has no wildcard bypass", () => {
    const owner = createHumanActor(IDENTITY, "owner");
    expectAuthorizationError(
      () => assertTenantAuthorized(owner, "acme-prod", "pack:read"),
      "tenant_mismatch",
    );
    expectAuthorizationError(
      () => assertTenantAuthorized(owner, "Acme", "pack:read"),
      "invalid_actor",
    );
    expectAuthorizationError(
      () => assertTenantAuthorized(owner, "*", "pack:read"),
      "invalid_actor",
    );
  });

  it("allows service actors only their explicit automation scopes", () => {
    const issued = issueApiToken(
      {
        tenantId: "acme",
        subjectId: "service:ci",
        scopes: ["pack:publish", "pack:read"],
        expiresAt: LATER,
      },
      NOW,
    );
    const service = authenticateApiToken(issued.token, [issued.record], NOW);
    expect(service).not.toBeNull();
    if (!service) throw new Error("expected service actor");

    expect(() => assertTenantAuthorized(service, "acme", "pack:read")).not.toThrow();
    expect(() => assertTenantAuthorized(service, "acme", "pack:publish")).not.toThrow();
    expectAuthorizationError(
      () => assertTenantAuthorized(service, "acme", "pack:deprecate"),
      "human_required",
    );
    expectAuthorizationError(
      () => assertTenantAuthorized(service, "acme", "member:manage"),
      "human_required",
    );
    expectAuthorizationError(
      () => assertTenantAuthorized(service, "another", "pack:read"),
      "tenant_mismatch",
    );
  });

  it("rejects forged service scopes instead of treating a token as an admin", () => {
    const forged = {
      kind: "service",
      tenantId: "acme",
      subjectId: "service:forged",
      tokenId: "token:forged",
      scopes: ["member:manage"],
    } as RegistryActor;
    expectAuthorizationError(
      () => assertTenantAuthorized(forged, "acme", "member:manage"),
      "invalid_actor",
    );
  });
});

describe("API token lifecycle", () => {
  it("generates independent 256-bit bearer values and stores only their SHA-256 metadata", () => {
    const input = {
      tenantId: "acme",
      subjectId: "service:release",
      scopes: ["pack:publish", "pack:read"] as const,
      expiresAt: LATER,
    };
    const first = issueApiToken(input, NOW);
    const second = issueApiToken(input, NOW);

    expect(first.token).toMatch(/^pit_[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.record.sha256).toBe(
      createHash("sha256").update(first.token, "utf8").digest("hex"),
    );
    expect(first.record.prefix).toBe(first.token.slice(0, first.record.prefix.length));
    expect(first.record.scopes).toEqual(["pack:publish", "pack:read"]);
    expect(first.record.revokedAt).toBeNull();
    expect(first.record).not.toHaveProperty("token");
    expect(first.record).not.toHaveProperty("secret");
    expect(JSON.stringify(first.record)).not.toContain(first.token);
    expect(Object.isFrozen(first.record)).toBe(true);
    expect(Object.isFrozen(first.record.scopes)).toBe(true);
  });

  it("requires a future expiry and service-safe, unique, non-empty scopes", () => {
    expect(() =>
      issueApiToken(
        {
          tenantId: "acme",
          subjectId: "service:ci",
          scopes: [],
          expiresAt: LATER,
        },
        NOW,
      ),
    ).toThrow("scopes must not be empty");
    expect(() =>
      issueApiToken(
        {
          tenantId: "acme",
          subjectId: "service:ci",
          scopes: ["pack:read", "pack:read"],
          expiresAt: LATER,
        },
        NOW,
      ),
    ).toThrow("Duplicate API token scope");
    expect(() =>
      issueApiToken(
        {
          tenantId: "acme",
          subjectId: "service:ci",
          scopes: ["token:issue"],
          expiresAt: LATER,
        },
        NOW,
      ),
    ).toThrow("requires a human actor");
    expect(() =>
      issueApiToken(
        {
          tenantId: "acme",
          subjectId: "service:ci",
          scopes: ["pack:read"],
          expiresAt: NOW,
        },
        NOW,
      ),
    ).toThrow("expiry must be in the future");
  });

  it("authenticates against fixed-size SHA-256 hashes and returns no token secret", () => {
    const issued = issueApiToken(
      {
        tenantId: "acme",
        subjectId: "service:ci",
        scopes: ["pack:read"],
        expiresAt: LATER,
      },
      NOW,
    );
    const actor = authenticateApiToken(issued.token, [issued.record], NOW);
    expect(actor).toEqual({
      kind: "service",
      tenantId: "acme",
      subjectId: "service:ci",
      tokenId: issued.record.tokenId,
      scopes: ["pack:read"],
    });
    expect(actor).not.toHaveProperty("sha256");
    expect(actor).not.toHaveProperty("token");

    const changedLastCharacter = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
    expect(authenticateApiToken(changedLastCharacter, [issued.record], NOW)).toBeNull();
    expect(authenticateApiToken("malformed", [issued.record], NOW)).toBeNull();
  });

  it("treats expiry as exclusive and revocation as permanent and idempotent", () => {
    const issued = issueApiToken(
      {
        tenantId: "acme",
        subjectId: "service:ci",
        scopes: ["pack:read"],
        expiresAt: LATER,
      },
      NOW,
    );
    expect(authenticateApiToken(issued.token, [issued.record], LATER)).toBeNull();

    const revoked = revokeApiToken(
      issued.record,
      new Date("2026-07-16T10:30:00.000Z"),
    );
    expect(revoked.revokedAt).toBe("2026-07-16T10:30:00.000Z");
    expect(authenticateApiToken(issued.token, [revoked], NOW)).toBeNull();
    expect(revokeApiToken(revoked, LATER)).toEqual(revoked);
    expect(() =>
      revokeApiToken(issued.record, new Date("2026-07-16T09:59:59.999Z")),
    ).toThrow("before it was created");
  });

  it("fails closed for corrupt, ambiguous, or prefix-inconsistent token records", () => {
    const issued = issueApiToken(
      {
        tenantId: "acme",
        subjectId: "service:ci",
        scopes: ["pack:read"],
        expiresAt: LATER,
      },
      NOW,
    );
    expect(() =>
      authenticateApiToken(issued.token, [
        { ...issued.record, sha256: "bad" } as ApiTokenRecord,
      ], NOW),
    ).toThrow("SHA-256 hash");
    expect(() =>
      authenticateApiToken(issued.token, [issued.record, issued.record], NOW),
    ).toThrow("Ambiguous duplicate");
    expect(() =>
      authenticateApiToken(issued.token, [
        {
          ...issued.record,
          prefix: `pit_${"z".repeat(10)}`,
        },
      ], NOW),
    ).toThrow("prefix does not match");
  });
});

describe("IdentityVerifier boundary", () => {
  it("deterministically verifies provider, assertion, and exact tenant binding", async () => {
    const verifier = new DeterministicIdentityVerifier([
      { assertion: "signed-test-assertion", identity: IDENTITY },
    ]);
    const request = {
      provider: "test-oidc",
      assertion: "signed-test-assertion",
      expectedTenantId: "acme",
    };

    await expect(verifier.verify(request)).resolves.toEqual(IDENTITY);
    await expect(
      verifier.verify({ ...request, assertion: "unknown" }),
    ).resolves.toBeNull();
    await expect(
      verifier.verify({ ...request, provider: "other-oidc" }),
    ).resolves.toBeNull();
    await expect(
      verifier.verify({ ...request, expectedTenantId: "acme-prod" }),
    ).resolves.toBeNull();
  });

  it("fails closed when a deterministic interactive fixture cannot prove the nonce", async () => {
    const nonce = "n".repeat(43);
    const verifier = new DeterministicIdentityVerifier([
      { assertion: "bound", identity: IDENTITY, nonce },
      { assertion: "unbound", identity: IDENTITY },
    ]);
    const request = {
      provider: "test-oidc",
      expectedTenantId: "acme",
      expectedNonce: nonce,
    };
    await expect(
      verifier.verify({ ...request, assertion: "bound" }),
    ).resolves.toEqual(IDENTITY);
    await expect(
      verifier.verify({ ...request, assertion: "unbound" }),
    ).resolves.toBeNull();
    await expect(
      verifier.verify({
        ...request,
        assertion: "bound",
        expectedNonce: "x".repeat(43),
      }),
    ).resolves.toBeNull();
  });

  it("does not expose mutable fixture identity state and rejects duplicate fixtures", async () => {
    const verifier = new DeterministicIdentityVerifier([
      { assertion: "fixture", identity: IDENTITY },
    ]);
    const request = {
      provider: "test-oidc",
      assertion: "fixture",
      expectedTenantId: "acme",
    };
    const first = await verifier.verify(request);
    if (!first) throw new Error("expected identity");
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { subjectId: string }).subjectId = "user:tampered";
    }).toThrow();
    await expect(verifier.verify(request)).resolves.toMatchObject({
      subjectId: "user:alice",
    });

    expect(
      () =>
        new DeterministicIdentityVerifier([
          { assertion: "same", identity: IDENTITY },
          { assertion: "same", identity: IDENTITY },
        ]),
    ).toThrow("Duplicate deterministic identity fixture");
  });

  it("creates a human actor only from a verified canonical identity", () => {
    expect(createHumanActor(IDENTITY, "admin")).toEqual({
      kind: "human",
      tenantId: "acme",
      subjectId: "user:alice",
      role: "admin",
      identityProvider: "test-oidc",
      identityIssuer: "https://identity.example.com/",
      identityVerifiedAt: NOW.toISOString(),
    });
    expect(() =>
      createHumanActor({ ...IDENTITY, tenantId: "Acme" }, "admin"),
    ).toThrow("canonical lowercase");
  });
});

function expectAuthorizationError(
  action: () => void,
  code: RegistryAuthorizationErrorCode,
): void {
  try {
    action();
    throw new Error(`Expected authorization error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryAuthorizationError);
    expect((error as RegistryAuthorizationError).code).toBe(code);
  }
}
