import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataType, newDb } from "pg-mem";
import { enablePgMemRlsCompat } from "./helpers/pg-mem-rls.js";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicIdentityVerifier } from "../src/registry-auth.js";
import type { RegistrySqlPool } from "../src/registry-postgres.js";
import {
  bootstrapPostgresRegistry,
  createRegistryPostgresPoolFromEnvironment,
  createRegistryPostgresPoolFromRequiredUrlEnvironment,
  createPostgresRegistryRuntime,
  issuePostgresBootstrapToken,
  loadRegistryBillingEnvironment,
  loadRegistryBrowserAuthEnvironment,
  loadRegistryOidcEnvironment,
  type CloseableRegistrySqlPool,
} from "../src/registry-runtime.js";

const pools: CloseableRegistrySqlPool[] = [];
const tempRoots: string[] = [];
const NOW = "2026-07-16T16:00:00.000Z";

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("self-hosted Registry runtime", () => {
  it("bootstraps idempotently, verifies an external identity, migrates, and reports readiness", async () => {
    const pool = createPool();
    const first = await bootstrapPostgresRegistry(
      pool,
      {
        provider: "test",
        identityIssuer: "https://identity.example.com",
        providerSubject: "owner-subject",
        displayName: "Owner",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
      () => new Date(NOW),
    );
    expect(first).toMatchObject({ createdUser: true, createdOrganization: true });
    const second = await bootstrapPostgresRegistry(
      pool,
      {
        provider: "test",
        identityIssuer: "https://identity.example.com",
        providerSubject: "owner-subject",
        displayName: "Owner",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
      () => new Date(NOW),
    );
    expect(second).toEqual({
      createdUser: false,
      createdOrganization: false,
      userId: first.userId,
      organizationId: first.organizationId,
    });
    await expect(
      bootstrapPostgresRegistry(
        pool,
        {
          provider: "test",
          identityIssuer: "https://replacement-idp.example.com/",
          providerSubject: "owner-subject",
          displayName: "Owner",
          organizationSlug: "acme",
          organizationName: "Acme",
        },
        () => new Date(NOW),
      ),
    ).rejects.toThrow(/different identity issuer/);

    const bootstrapToken = await issuePostgresBootstrapToken(
      pool,
      {
        provider: "test",
        identityIssuer: "https://identity.example.com",
        providerSubject: "owner-subject",
        organizationSlug: "acme",
        scopes: ["pack:read", "pack:publish"],
        expiresAt: "2027-07-16T16:00:00.000Z",
      },
      () => new Date(NOW),
    );
    expect(bootstrapToken).toMatchObject({
      token: expect.stringMatching(/^pit_/),
      organizationId: first.organizationId,
      subjectId: first.userId,
      scopes: ["pack:publish", "pack:read"],
    });

    const verifier = new DeterministicIdentityVerifier([
      {
        assertion: "signed-fixture",
        identity: {
          provider: "test",
          issuer: "https://identity.example.com/",
          providerSubjectId: "owner-subject",
          subjectId: "external-subject",
          tenantId: first.organizationId,
          verifiedAt: NOW,
        },
      },
      {
        assertion: "reviewer-fixture",
        identity: {
          provider: "test",
          issuer: "https://identity.example.com/",
          providerSubjectId: "reviewer-subject",
          subjectId: "external-reviewer",
          tenantId: first.organizationId,
          verifiedAt: NOW,
        },
      },
      {
        assertion: "replacement-issuer-fixture",
        identity: {
          provider: "test",
          issuer: "https://replacement-idp.example.com/",
          providerSubjectId: "owner-subject",
          subjectId: "replacement-external-subject",
          tenantId: first.organizationId,
          verifiedAt: NOW,
        },
      },
    ]);
    const runtime = await createPostgresRegistryRuntime({
      pool,
      closePool: false,
      identity: { provider: "test", verifier },
      clock: () => new Date(NOW),
    });
    expect(runtime.migrations.applied).toEqual([]);
    expect(runtime.migrations.skipped).toEqual([
      "001_registry.sql",
      "002_registry_runtime.sql",
      "003_registry_telemetry.sql",
      "004_registry_identity_issuer.sql",
      "005_registry_row_level_security.sql",
      "006_registry_public_release_rls.sql",
      "007_registry_append_only_integrity.sql",
      "008_registry_semver_keyset.sql",
      "009_registry_public_discovery.sql",
    ]);
    const ready = await runtime.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    const me = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: "Bearer signed-fixture" },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({
      kind: "human",
      tenant_id: first.organizationId,
      subject_id: first.userId,
      role: "owner",
    });
    const issuerReplacement = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: "Bearer replacement-issuer-fixture" },
    });
    expect(issuerReplacement.statusCode).toBe(401);
    const provisioned = await runtime.app.inject({
      method: "POST",
      url: `/v1/orgs/${first.organizationId}/members/provision`,
      headers: { authorization: "Bearer signed-fixture" },
      payload: {
        provider_subject: "reviewer-subject",
        display_name: "Reviewer",
        role: "admin",
      },
    });
    expect(provisioned.statusCode).toBe(201);
    expect(provisioned.json().data).toMatchObject({
      org_id: first.organizationId,
      role: "admin",
    });
    const repeatedProvision = await runtime.app.inject({
      method: "POST",
      url: `/v1/orgs/${first.organizationId}/members/provision`,
      headers: { authorization: "Bearer signed-fixture" },
      payload: {
        provider_subject: "reviewer-subject",
        display_name: "Ignored on idempotent retry",
        role: "admin",
      },
    });
    expect(repeatedProvision.statusCode).toBe(201);
    expect(repeatedProvision.json().data.user_id).toBe(
      provisioned.json().data.user_id,
    );
    const reviewerMe = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: "Bearer reviewer-fixture" },
    });
    expect(reviewerMe.statusCode).toBe(200);
    expect(reviewerMe.json().data).toMatchObject({
      kind: "human",
      tenant_id: first.organizationId,
      subject_id: provisioned.json().data.user_id,
      role: "admin",
    });
    await pool.query(
      `UPDATE registry_memberships
          SET role = 'viewer'
        WHERE org_id = $1 AND user_id = $2`,
      [first.organizationId, provisioned.json().data.user_id],
    );
    const changedRole = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: "Bearer reviewer-fixture" },
    });
    expect(changedRole.statusCode).toBe(200);
    expect(changedRole.json().data.role).toBe("viewer");
    await pool.query(
      `UPDATE registry_users SET status = 'suspended' WHERE id = $1`,
      [provisioned.json().data.user_id],
    );
    const suspendedReviewer = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: "Bearer reviewer-fixture" },
    });
    expect(suspendedReviewer.statusCode).toBe(401);
    const serviceMe = await runtime.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${first.organizationId}`,
      headers: { authorization: `Bearer ${bootstrapToken.token}` },
    });
    expect(serviceMe.statusCode).toBe(200);
    expect(serviceMe.json().data).toMatchObject({
      kind: "service",
      tenant_id: first.organizationId,
      subject_id: first.userId,
      scopes: ["pack:publish", "pack:read"],
    });
    const serviceProvision = await runtime.app.inject({
      method: "POST",
      url: `/v1/orgs/${first.organizationId}/members/provision`,
      headers: { authorization: `Bearer ${bootstrapToken.token}` },
      payload: {
        provider_subject: "forbidden-subject",
        display_name: "Forbidden",
        role: "admin",
      },
    });
    expect(serviceProvision.statusCode).toBe(403);
    await runtime.close();
    await expect(pool.query("SELECT 1 AS alive")).resolves.toMatchObject({
      rows: [{ alive: 1 }],
    });
  });

  it("requires complete explicit OIDC environment configuration", () => {
    expect(loadRegistryOidcEnvironment({})).toBeNull();
    expect(() =>
      loadRegistryOidcEnvironment({ PITLORE_OIDC_PROVIDER: "partial" }),
    ).toThrow(/PITLORE_OIDC_ISSUER/);
  });

  it("requires complete browser auth environment configuration", () => {
    expect(loadRegistryBrowserAuthEnvironment({})).toBeNull();
    expect(() =>
      loadRegistryBrowserAuthEnvironment({
        PITLORE_BROWSER_AUTH_AUTHORIZE_URL: "https://idp.example.com/authorize",
      }),
    ).toThrow(/PITLORE_BROWSER_AUTH_TOKEN_URL/);
    expect(
      loadRegistryBrowserAuthEnvironment({
        PITLORE_BROWSER_AUTH_AUTHORIZE_URL: "https://idp.example.com/authorize",
        PITLORE_BROWSER_AUTH_TOKEN_URL: "https://idp.example.com/token",
        PITLORE_BROWSER_AUTH_CLIENT_ID: "pitlore-web",
        PITLORE_BROWSER_AUTH_REDIRECT_URI: "https://registry.example.com/auth/callback",
      }),
    ).toEqual({
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "pitlore-web",
      redirectUri: "https://registry.example.com/auth/callback",
    });
  });

  it("wires browser login into the runtime only alongside the identity verifier", async () => {
    const withoutIdentity = createPool();
    await expect(
      createPostgresRegistryRuntime({
        pool: withoutIdentity,
        closePool: true,
        browserAuth: {
          authorizationEndpoint: "https://idp.example.com/authorize",
          tokenEndpoint: "https://idp.example.com/token",
          clientId: "pitlore-web",
          redirectUri: "https://registry.example.com/auth/callback",
        },
      }),
    ).rejects.toThrow("browser login requires the OIDC identity verifier");

    const pool = createPool();
    const runtime = await createPostgresRegistryRuntime({
      pool,
      closePool: true,
      identity: {
        provider: "test",
        verifier: new DeterministicIdentityVerifier([]),
      },
      browserAuth: {
        authorizationEndpoint: "https://idp.example.com/authorize",
        tokenEndpoint: "https://idp.example.com/token",
        clientId: "pitlore-web",
        redirectUri: "https://registry.example.com/auth/callback",
      },
    });
    try {
      const login = await runtime.app.inject({
        method: "GET",
        url: "/auth/login?org_id=11111111-1111-4111-8111-111111111111",
      });
      expect(login.statusCode).toBe(302);
      const location = new URL(String(login.headers.location));
      expect(location.origin + location.pathname).toBe(
        "https://idp.example.com/authorize",
      );
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      const session = await runtime.app.inject({
        method: "GET",
        url: "/auth/session",
      });
      expect(session.json()).toMatchObject({ authenticated: false });
    } finally {
      await runtime.close();
    }
  });
});

describe("Registry secret-file environment", () => {
  it("requires the explicitly named migration-owner URL without split fallback", () => {
    expect(() =>
      createRegistryPostgresPoolFromRequiredUrlEnvironment(
        {
          PITLORE_REGISTRY_DATABASE_HOST: "runtime-db.example.com",
          PITLORE_REGISTRY_DATABASE_NAME: "pitlore",
          PITLORE_REGISTRY_DATABASE_USER: "pitlore-runtime",
          PITLORE_REGISTRY_DATABASE_PASSWORD: "runtime-secret",
        },
        "PITLORE_MIGRATION_OWNER_URL",
      ),
    ).toThrow(
      "Registry migration-owner database URL is required in PITLORE_MIGRATION_OWNER_URL",
    );

    expect(() =>
      createRegistryPostgresPoolFromRequiredUrlEnvironment(
        { PITLORE_MIGRATION_OWNER_URL: "postgresql://owner@localhost/pitlore" },
        "invalid-name",
      ),
    ).toThrow("Registry database URL environment variable name is invalid");
  });

  it("accepts only a PostgreSQL owner URL without an independent password source", () => {
    const pool = createRegistryPostgresPoolFromRequiredUrlEnvironment(
      {
        PITLORE_MIGRATION_OWNER_URL:
          "  postgresql://migration_owner:owner-secret@db.example.com:5433/pitlore  ",
      },
      "PITLORE_MIGRATION_OWNER_URL",
    );
    pools.push(pool);
    expect(
      (
        pool as unknown as {
          options: { connectionString: string };
        }
      ).options.connectionString,
    ).toBe(
      "postgresql://migration_owner:owner-secret@db.example.com:5433/pitlore",
    );

    expect(() =>
      createRegistryPostgresPoolFromRequiredUrlEnvironment(
        { PITLORE_MIGRATION_OWNER_URL: "https://db.example.com/pitlore" },
        "PITLORE_MIGRATION_OWNER_URL",
      ),
    ).toThrow("Registry database URL must use postgres or postgresql");

    const passwordFile = writeSecret("separate-secret", "owner-url-conflict");
    for (const extraSecret of [
      { PITLORE_REGISTRY_DATABASE_PASSWORD: "separate-secret" },
      { PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: passwordFile },
    ]) {
      expect(() =>
        createRegistryPostgresPoolFromRequiredUrlEnvironment(
          {
            PITLORE_MIGRATION_OWNER_URL:
              "postgresql://migration_owner:owner-secret@db.example.com/pitlore",
            ...extraSecret,
          },
          "PITLORE_MIGRATION_OWNER_URL",
        ),
      ).toThrow(
        "PITLORE_MIGRATION_OWNER_URL cannot be combined with a separate Registry database password source",
      );
    }
  });

  it("loads both supported secret files and removes exactly one trailing newline", () => {
    const databasePassword = writeSecret("database-secret\r\n", "database-password");
    const pool = createRegistryPostgresPoolFromEnvironment({
      PITLORE_REGISTRY_DATABASE_HOST: "localhost",
      PITLORE_REGISTRY_DATABASE_NAME: "pitlore",
      PITLORE_REGISTRY_DATABASE_USER: "pitlore-runtime",
      PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: databasePassword,
    });
    pools.push(pool);
    expect(
      (pool as unknown as { options: { password: string } }).options.password,
    ).toBe("database-secret");

    const billingSecret = writeSecret("billing-secret\n\n", "billing-secret");
    expect(
      loadRegistryBillingEnvironment({
        PITLORE_BILLING_MODE: "enforced",
        PITLORE_BILLING_PROVIDER: "test-provider",
        PITLORE_BILLING_WEBHOOK_SECRET_FILE: billingSecret,
      }),
    ).toEqual({
      billingMode: "enforced",
      billingWebhook: {
        provider: "test-provider",
        secret: "billing-secret\n",
      },
    });
  });

  it("rejects configuring a direct value together with its file source", () => {
    const filename = writeSecret("file-secret", "conflict-secret");
    expect(() =>
      createRegistryPostgresPoolFromEnvironment({
        PITLORE_REGISTRY_DATABASE_URL: "postgres://pitlore:secret@localhost/pitlore",
        PITLORE_REGISTRY_DATABASE_PASSWORD: "direct-secret",
        PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: filename,
      }),
    ).toThrow(/exactly one.*DATABASE_PASSWORD/);
    expect(() =>
      loadRegistryBillingEnvironment({
        PITLORE_BILLING_PROVIDER: "test-provider",
        PITLORE_BILLING_WEBHOOK_SECRET: "direct-secret",
        PITLORE_BILLING_WEBHOOK_SECRET_FILE: filename,
      }),
    ).toThrow(/exactly one.*BILLING_WEBHOOK_SECRET/);
  });

  it("rejects a separate password source when a database URL is configured", () => {
    const filename = writeSecret("file-secret", "url-conflict-secret");
    expect(() =>
      createRegistryPostgresPoolFromEnvironment({
        PITLORE_REGISTRY_DATABASE_URL: "postgres://pitlore:secret@localhost/pitlore",
        PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: filename,
      }),
    ).toThrow(/DATABASE_URL cannot be combined/);
    expect(() =>
      createRegistryPostgresPoolFromEnvironment({
        PITLORE_REGISTRY_DATABASE_URL: "postgres://pitlore:secret@localhost/pitlore",
        PITLORE_REGISTRY_DATABASE_PASSWORD: "direct-secret",
      }),
    ).toThrow(/DATABASE_URL cannot be combined/);
  });

  it("rejects empty, non-regular, symbolic-link, and oversized secret files", () => {
    const empty = writeSecret("", "empty");
    const newlineOnly = writeSecret("\n", "newline-only");
    const oversized = writeSecret(Buffer.alloc(64 * 1024 + 1, 0x61), "oversized");
    const directory = createTempRoot("directory");
    for (const filename of [empty, newlineOnly, oversized, directory]) {
      expect(() =>
        loadRegistryBillingEnvironment({
          PITLORE_BILLING_PROVIDER: "test-provider",
          PITLORE_BILLING_WEBHOOK_SECRET_FILE: filename,
        }),
      ).toThrow();
    }

    if (process.platform !== "win32") {
      const target = writeSecret("link-target", "link-target");
      const link = path.join(path.dirname(target), "secret-link");
      fs.symlinkSync(target, link);
      expect(() =>
        loadRegistryBillingEnvironment({
          PITLORE_BILLING_PROVIDER: "test-provider",
          PITLORE_BILLING_WEBHOOK_SECRET_FILE: link,
        }),
      ).toThrow(/regular file/);
    }
  });

  it("rejects missing or empty required secret values", () => {
    expect(() =>
      createRegistryPostgresPoolFromEnvironment({
        PITLORE_REGISTRY_DATABASE_HOST: "localhost",
        PITLORE_REGISTRY_DATABASE_NAME: "pitlore",
        PITLORE_REGISTRY_DATABASE_USER: "pitlore-runtime",
        PITLORE_REGISTRY_DATABASE_PASSWORD: "",
      }),
    ).toThrow(/DATABASE_PASSWORD/);
    expect(() =>
      loadRegistryBillingEnvironment({
        PITLORE_BILLING_MODE: "enforced",
        PITLORE_BILLING_PROVIDER: "test-provider",
        PITLORE_BILLING_WEBHOOK_SECRET: "",
      }),
    ).toThrow(/secret source/);
  });
});

function createTempRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pitlore-secret-${name}-`));
  tempRoots.push(root);
  return root;
}

function writeSecret(content: string | Buffer, name: string): string {
  const root = createTempRoot(name);
  const filename = path.join(root, "secret");
  fs.writeFileSync(filename, content, { mode: 0o600 });
  return filename;
}

function createPool(): CloseableRegistrySqlPool {
  const database = newDb();
  enablePgMemRlsCompat(database);
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
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
  pools.push(pool);
  return pool;
}
