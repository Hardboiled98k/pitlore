import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { JSONWebKeySet } from "jose";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import {
  issueApiToken,
  type IdentityVerifier,
  type RegistryPermission,
} from "./registry-auth.js";
import {
  createPostgresOidcActorResolver,
  resolvePostgresVerifiedIdentityActor,
} from "./registry-identity-service.js";
import {
  OidcJwtIdentityVerifier,
  canonicalizeOidcIssuer,
} from "./registry-oidc.js";
import { PostgresRegistryApplication } from "./registry-postgres-application.js";
import {
  PostgresBillingWebhookHandler,
  PostgresRegistryEntitlementService,
  PostgresRegistryUsageLedger,
} from "./registry-postgres-telemetry.js";
import {
  applyRegistryMigrations,
  PostgresRegistryRepository,
  type RegistryMigrationResult,
  type RegistrySqlPool,
} from "./registry-postgres.js";
import {
  createRegistryServer,
  normalizeRegistryTrustProxy,
  type RegistryActorResolver,
} from "./registry-server.js";
import { PostgresRegistryTokenService } from "./registry-token-service.js";

const MAX_SECRET_FILE_BYTES = 64 * 1024;

export interface CloseableRegistrySqlPool extends RegistrySqlPool {
  end(): Promise<void>;
}

export interface PostgresRegistryRuntimeOptions {
  readonly databaseUrl?: string;
  readonly pool?: CloseableRegistrySqlPool;
  readonly actorResolver?: RegistryActorResolver;
  readonly identity?: {
    readonly verifier: IdentityVerifier;
    readonly provider: string;
  };
  readonly clock?: () => Date;
  readonly bodyLimit?: number;
  /** Exact IP/CIDR allow-list for reverse proxies allowed to set client IP. */
  readonly trustProxy?: string | readonly string[];
  readonly closePool?: boolean;
  readonly billingMode?: "off" | "enforced";
  readonly billingWebhook?: {
    readonly provider: string;
    readonly secret: string;
  };
  /**
   * Optional browser login endpoints; requires `identity` so the login flow
   * reuses the same verifier and provider as API OIDC assertions.
   */
  readonly browserAuth?: {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly redirectUri: string;
  };
}

export interface PostgresRegistryRuntime {
  readonly app: FastifyInstance;
  readonly pool: CloseableRegistrySqlPool;
  readonly migrations: RegistryMigrationResult;
  close(): Promise<void>;
}

export async function createPostgresRegistryRuntime(
  options: PostgresRegistryRuntimeOptions,
): Promise<PostgresRegistryRuntime> {
  if (options.pool && options.databaseUrl) {
    throw new Error(
      "Registry runtime accepts either pool or databaseUrl, not both",
    );
  }
  const ownsPool = !options.pool;
  const pool =
    options.pool ??
    createRegistryPostgresPool(requireDatabaseUrl(options.databaseUrl));
  const closePool = options.closePool ?? ownsPool;
  try {
    const migrations = await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    const billingMode = options.billingMode ?? "off";
    const domain = new PostgresRegistryApplication(repository, {
      clock: options.clock,
      billingMode,
    });
    const tokenService = new PostgresRegistryTokenService(repository, {
      clock: options.clock,
    });
    if (billingMode === "enforced" && !options.billingWebhook) {
      throw new Error(
        "Enforced Registry billing requires a signed webhook configuration",
      );
    }
    const usageLedger = new PostgresRegistryUsageLedger(
      pool,
      billingMode,
      options.clock,
    );
    const entitlements = new PostgresRegistryEntitlementService(
      pool,
      billingMode,
    );
    const billingWebhookHandler = options.billingWebhook
      ? new PostgresBillingWebhookHandler(
          pool,
          options.billingWebhook.provider,
          options.billingWebhook.secret,
        )
      : undefined;
    const actorResolver = resolveActorResolver(options, repository);
    if (options.browserAuth && !options.identity) {
      throw new Error(
        "Registry browser login requires the OIDC identity verifier to be configured",
      );
    }
    const app = createRegistryServer({
      domain,
      tokenService,
      usageLedger,
      entitlements,
      billingWebhookHandler,
      actorResolver,
      clock: options.clock,
      bodyLimit: options.bodyLimit,
      trustProxy: options.trustProxy,
      ...(options.browserAuth && options.identity
        ? {
            browserAuth: {
              ...options.browserAuth,
              provider: options.identity.provider,
              verifier: options.identity.verifier,
              resolveActor: (identity) =>
                resolvePostgresVerifiedIdentityActor(identity, repository),
            },
          }
        : {}),
      readiness: async () => {
        try {
          await pool.query("SELECT 1 AS ready");
          return true;
        } catch {
          return false;
        }
      },
    });
    let closed = false;
    return Object.freeze({
      app,
      pool,
      migrations,
      async close() {
        if (closed) return;
        closed = true;
        await app.close();
        if (closePool) await pool.end();
      },
    });
  } catch (error) {
    if (closePool) await pool.end();
    throw error;
  }
}

export interface RegistryBootstrapInput {
  readonly provider: string;
  readonly identityIssuer: string;
  readonly providerSubject: string;
  readonly displayName: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
}

export interface RegistryBootstrapResult {
  readonly createdUser: boolean;
  readonly createdOrganization: boolean;
  readonly userId: string;
  readonly organizationId: string;
}

export interface RegistryBootstrapTokenInput {
  readonly provider: string;
  readonly identityIssuer: string;
  readonly providerSubject: string;
  readonly organizationSlug: string;
  readonly scopes: readonly RegistryPermission[];
  readonly expiresAt: string;
}

export interface RegistryBootstrapTokenResult {
  /** Returned exactly once. The database stores only its SHA-256 digest. */
  readonly token: string;
  readonly tokenId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  readonly prefix: string;
  readonly scopes: readonly RegistryPermission[];
  readonly expiresAt: string;
}

export async function bootstrapPostgresRegistry(
  pool: CloseableRegistrySqlPool,
  input: RegistryBootstrapInput,
  clock: () => Date = () => new Date(),
): Promise<RegistryBootstrapResult> {
  const parsed = BootstrapInputSchema.parse(input);
  await applyRegistryMigrations(pool);
  const repository = new PostgresRegistryRepository(pool);
  const now = canonicalNow(clock);
  let user = await repository.getUserByExternalIdentity(
    parsed.provider,
    parsed.providerSubject,
  );
  const createdUser = !user;
  if (!user) {
    user = await repository.insertUser({
      id: randomUUID(),
      issuer: parsed.provider,
      identity_issuer: parsed.identityIssuer,
      subject: parsed.providerSubject,
      display_name: parsed.displayName,
      created_at: now,
    });
  } else {
    user = await repository.bindUserIdentityIssuer(
      user.id,
      parsed.identityIssuer,
    );
  }
  let organization = await repository.getOrganizationBySlug(
    parsed.organizationSlug,
  );
  const createdOrganization = !organization;
  if (organization && organization.owner_user_id !== user.id) {
    throw new Error(
      "Registry organization slug belongs to another bootstrap owner",
    );
  }
  if (!organization) {
    organization = await repository.transaction(async (transaction) => {
      const organizationId = randomUUID();
      // The new organization's id doubles as the RLS tenant context for the
      // owner-membership and audit rows created in this same transaction.
      await transaction.setTenantContext(organizationId);
      const created = await transaction.createOrganization({
        id: organizationId,
        slug: parsed.organizationSlug,
        name: parsed.organizationName,
        owner_user_id: user.id,
        created_at: now,
      });
      await transaction.appendAuditEvent({
        event_id: randomUUID(),
        request_id: `bootstrap:${randomUUID()}`,
        org_id: created.id,
        actor_id: null,
        actor_kind: "system",
        action: "organization.bootstrapped",
        target_type: "organization",
        target_id: created.id,
        metadata: {
          slug: created.slug,
          provider: parsed.provider,
          identity_issuer: parsed.identityIssuer,
        },
        occurred_at: now,
      });
      return created;
    });
  }
  return Object.freeze({
    createdUser,
    createdOrganization,
    userId: user.id,
    organizationId: organization.id,
  });
}

/**
 * Recovery/bootstrap path for a self-host operator who has direct database
 * access but has not connected an OIDC provider yet. It can mint only the two
 * service-safe Pack scopes and only for the organization's current owner.
 */
export async function issuePostgresBootstrapToken(
  pool: CloseableRegistrySqlPool,
  input: RegistryBootstrapTokenInput,
  clock: () => Date = () => new Date(),
): Promise<RegistryBootstrapTokenResult> {
  const parsed = BootstrapTokenInputSchema.parse(input);
  await applyRegistryMigrations(pool);
  const repository = new PostgresRegistryRepository(pool);
  const now = canonicalNow(clock);
  return repository.transaction(async (transaction) => {
    const user = await transaction.getUserByVerifiedExternalIdentity(
      parsed.provider,
      parsed.identityIssuer,
      parsed.providerSubject,
    );
    const organization = await transaction.getOrganizationBySlug(
      parsed.organizationSlug,
    );
    if (!user || user.status !== "active" || !organization) {
      throw new Error("Registry bootstrap owner was not found");
    }
    await transaction.setTenantContext(organization.id);
    const membership = await transaction.getMember(organization.id, user.id);
    if (
      !membership ||
      membership.role !== "owner" ||
      organization.owner_user_id !== user.id
    ) {
      throw new Error("Registry bootstrap token requires the current owner");
    }
    const issued = issueApiToken(
      {
        tenantId: organization.id,
        subjectId: user.id,
        scopes: parsed.scopes,
        expiresAt: parsed.expiresAt,
      },
      new Date(now),
    );
    const stored = await transaction.insertApiToken(issued.record);
    await transaction.appendAuditEvent({
      event_id: randomUUID(),
      request_id: `bootstrap-token:${randomUUID()}`,
      org_id: organization.id,
      actor_id: null,
      actor_kind: "system",
      action: "token.issued",
      target_type: "api_token",
      target_id: stored.tokenId,
      metadata: {
        bootstrap: true,
        prefix: stored.prefix,
        scopes: stored.scopes.join(","),
        expires_at: stored.expiresAt,
      },
      occurred_at: now,
    });
    return Object.freeze({
      token: issued.token,
      tokenId: stored.tokenId,
      organizationId: organization.id,
      subjectId: user.id,
      prefix: stored.prefix,
      scopes: Object.freeze([...stored.scopes]),
      expiresAt: stored.expiresAt,
    });
  });
}

export interface RegistryOidcEnvironment {
  readonly provider: string;
  readonly verifier: OidcJwtIdentityVerifier;
}

export interface RegistryBillingEnvironment {
  readonly billingMode: "off" | "enforced";
  readonly billingWebhook?: {
    readonly provider: string;
    readonly secret: string;
  };
}

export function loadRegistryBillingEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RegistryBillingEnvironment {
  const mode = env.PITLORE_BILLING_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "enforced") {
    throw new Error("PITLORE_BILLING_MODE must be off or enforced");
  }
  const provider = env.PITLORE_BILLING_PROVIDER?.trim();
  const secret = optionalSecretEnvironment(
    env,
    "PITLORE_BILLING_WEBHOOK_SECRET",
    "PITLORE_BILLING_WEBHOOK_SECRET_FILE",
  );
  if ((provider ? 1 : 0) !== (secret ? 1 : 0)) {
    throw new Error(
      "PITLORE_BILLING_PROVIDER and exactly one billing webhook secret source must be configured together",
    );
  }
  if (mode === "enforced" && (!provider || !secret)) {
    throw new Error(
      "Enforced Registry billing requires provider and webhook secret",
    );
  }
  return Object.freeze({
    billingMode: mode,
    ...(provider && secret
      ? { billingWebhook: Object.freeze({ provider, secret }) }
      : {}),
  });
}

export function loadRegistryOidcEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RegistryOidcEnvironment | null {
  const names = [
    "PITLORE_OIDC_PROVIDER",
    "PITLORE_OIDC_ISSUER",
    "PITLORE_OIDC_AUDIENCE",
    "PITLORE_OIDC_ALGORITHMS",
    "PITLORE_OIDC_JWKS_URL",
    "PITLORE_OIDC_JWKS_FILE",
  ] as const;
  if (names.every((name) => !env[name]?.trim())) return null;
  const provider = requiredEnvironment(env, "PITLORE_OIDC_PROVIDER");
  const issuer = requiredEnvironment(env, "PITLORE_OIDC_ISSUER");
  const audience = splitEnvironmentList(
    requiredEnvironment(env, "PITLORE_OIDC_AUDIENCE"),
  );
  const algorithms = splitEnvironmentList(
    requiredEnvironment(env, "PITLORE_OIDC_ALGORITHMS"),
  );
  const jwksUrl = env.PITLORE_OIDC_JWKS_URL?.trim();
  const jwksFile = env.PITLORE_OIDC_JWKS_FILE?.trim();
  if ((jwksUrl ? 1 : 0) + (jwksFile ? 1 : 0) !== 1) {
    throw new Error(
      "Configure exactly one of PITLORE_OIDC_JWKS_URL or PITLORE_OIDC_JWKS_FILE",
    );
  }
  const jwks = jwksUrl ? new URL(jwksUrl) : readLocalJwks(jwksFile!);
  return Object.freeze({
    provider,
    verifier: new OidcJwtIdentityVerifier({
      provider,
      issuer,
      audience,
      algorithms,
      jwks,
      tenantClaim: env.PITLORE_OIDC_TENANT_CLAIM?.trim() || "org_id",
    }),
  });
}

export interface RegistryBrowserAuthEnvironment {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

/**
 * Forwarding headers stay untrusted unless operators explicitly name the
 * reverse-proxy source IPs/subnets. Validation rejects hostnames, wildcards,
 * and whole-address-family /0 ranges.
 */
export function loadRegistryTrustProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] | undefined {
  const configured = env.PITLORE_TRUST_PROXY;
  if (configured === undefined || configured.trim() === "") return undefined;
  return Object.freeze(normalizeRegistryTrustProxy(configured) ?? []);
}

/**
 * All-or-none browser login configuration. URL/format validation happens at
 * server construction so misconfiguration fails at startup, not at login time.
 */
export function loadRegistryBrowserAuthEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RegistryBrowserAuthEnvironment | null {
  const names = [
    "PITLORE_BROWSER_AUTH_AUTHORIZE_URL",
    "PITLORE_BROWSER_AUTH_TOKEN_URL",
    "PITLORE_BROWSER_AUTH_CLIENT_ID",
    "PITLORE_BROWSER_AUTH_REDIRECT_URI",
  ] as const;
  if (names.every((name) => !env[name]?.trim())) return null;
  return Object.freeze({
    authorizationEndpoint: requiredEnvironment(
      env,
      "PITLORE_BROWSER_AUTH_AUTHORIZE_URL",
    ),
    tokenEndpoint: requiredEnvironment(env, "PITLORE_BROWSER_AUTH_TOKEN_URL"),
    clientId: requiredEnvironment(env, "PITLORE_BROWSER_AUTH_CLIENT_ID"),
    redirectUri: requiredEnvironment(env, "PITLORE_BROWSER_AUTH_REDIRECT_URI"),
  });
}

export function createRegistryPostgresPool(
  database: string | RegistryPostgresConnectionOptions,
): CloseableRegistrySqlPool {
  const connection: PoolConfig =
    typeof database === "string"
      ? { connectionString: requireDatabaseUrl(database) }
      : validateConnectionOptions(database);
  return new Pool({
    ...connection,
    // Registry queries are short, bounded OLTP operations. RLS can inflate
    // planner cost estimates enough to trigger hundreds of JIT functions even
    // when the chosen facet plan touches only a handful of rows.
    options: registryPostgresSessionOptions(database),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    application_name: "pitlore-registry",
  }) as unknown as CloseableRegistrySqlPool;
}

function registryPostgresSessionOptions(
  database: string | RegistryPostgresConnectionOptions,
): string {
  if (typeof database !== "string") return "-c jit=off";
  const url = new URL(requireDatabaseUrl(database));
  const configured = url.searchParams.get("options")?.trim();
  return configured ? `${configured} -c jit=off` : "-c jit=off";
}

export interface RegistryPostgresConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl?: boolean | { readonly rejectUnauthorized: true };
}

export function createRegistryPostgresPoolFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrlEnvironment = "PITLORE_REGISTRY_DATABASE_URL",
): CloseableRegistrySqlPool {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseUrlEnvironment)) {
    throw new Error(
      "Registry database URL environment variable name is invalid",
    );
  }
  assertExclusiveSecretEnvironment(
    env,
    "PITLORE_REGISTRY_DATABASE_PASSWORD",
    "PITLORE_REGISTRY_DATABASE_PASSWORD_FILE",
  );
  const databaseUrl = env[databaseUrlEnvironment]?.trim();
  if (databaseUrl) {
    if (
      (env.PITLORE_REGISTRY_DATABASE_PASSWORD?.length ?? 0) > 0 ||
      (env.PITLORE_REGISTRY_DATABASE_PASSWORD_FILE?.trim().length ?? 0) > 0
    ) {
      throw new Error(
        `${databaseUrlEnvironment} cannot be combined with a separate Registry database password source`,
      );
    }
    return createRegistryPostgresPool(databaseUrl);
  }
  const portValue = env.PITLORE_REGISTRY_DATABASE_PORT?.trim() || "5432";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PITLORE_REGISTRY_DATABASE_PORT must be a valid port");
  }
  const sslMode = env.PITLORE_REGISTRY_DATABASE_SSL?.trim() || "disable";
  if (sslMode !== "disable" && sslMode !== "require") {
    throw new Error("PITLORE_REGISTRY_DATABASE_SSL must be disable or require");
  }
  return createRegistryPostgresPool({
    host: requiredEnvironment(env, "PITLORE_REGISTRY_DATABASE_HOST"),
    port,
    database: requiredEnvironment(env, "PITLORE_REGISTRY_DATABASE_NAME"),
    user: requiredEnvironment(env, "PITLORE_REGISTRY_DATABASE_USER"),
    password: requiredSecretEnvironment(
      env,
      "PITLORE_REGISTRY_DATABASE_PASSWORD",
      "PITLORE_REGISTRY_DATABASE_PASSWORD_FILE",
    ),
    ssl: sslMode === "require" ? { rejectUnauthorized: true } : false,
  });
}

/**
 * Create a PostgreSQL pool from one explicitly named URL environment variable.
 *
 * Operator-only commands use this stricter path so a missing migration-owner
 * URL cannot silently fall back to the runtime role's split credentials.
 */
export function createRegistryPostgresPoolFromRequiredUrlEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrlEnvironment = "PITLORE_REGISTRY_DATABASE_URL",
): CloseableRegistrySqlPool {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseUrlEnvironment)) {
    throw new Error(
      "Registry database URL environment variable name is invalid",
    );
  }
  assertExclusiveSecretEnvironment(
    env,
    "PITLORE_REGISTRY_DATABASE_PASSWORD",
    "PITLORE_REGISTRY_DATABASE_PASSWORD_FILE",
  );
  const databaseUrl = env[databaseUrlEnvironment]?.trim();
  if (!databaseUrl) {
    throw new Error(
      `Registry migration-owner database URL is required in ${databaseUrlEnvironment}`,
    );
  }
  if (
    (env.PITLORE_REGISTRY_DATABASE_PASSWORD?.length ?? 0) > 0 ||
    (env.PITLORE_REGISTRY_DATABASE_PASSWORD_FILE?.trim().length ?? 0) > 0
  ) {
    throw new Error(
      `${databaseUrlEnvironment} cannot be combined with a separate Registry database password source`,
    );
  }
  return createRegistryPostgresPool(databaseUrl);
}

function requireDatabaseUrl(value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error("Registry PostgreSQL database URL is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Registry PostgreSQL database URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Registry database URL must use postgres or postgresql");
  }
  return value;
}

function validateConnectionOptions(
  input: RegistryPostgresConnectionOptions,
): PoolConfig {
  if (
    typeof input.host !== "string" ||
    input.host.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(input.host)
  ) {
    throw new Error("Registry database host is invalid");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("Registry database port is invalid");
  }
  for (const [label, value] of [
    ["name", input.database],
    ["user", input.user],
    ["password", input.password],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000")
    ) {
      throw new Error(`Registry database ${label} is invalid`);
    }
  }
  return {
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
    ssl: input.ssl,
  };
}

function resolveActorResolver(
  options: PostgresRegistryRuntimeOptions,
  repository: PostgresRegistryRepository,
): RegistryActorResolver | undefined {
  if (options.actorResolver && options.identity) {
    throw new Error(
      "Registry runtime accepts actorResolver or identity, not both",
    );
  }
  return (
    options.actorResolver ??
    (options.identity
      ? createPostgresOidcActorResolver(
          options.identity.verifier,
          options.identity.provider,
          repository,
        )
      : undefined)
  );
}

const BootstrapInputSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    identityIssuer: z
      .string()
      .max(2_048)
      .transform((value, context) => {
        try {
          return canonicalizeOidcIssuer(value);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              error instanceof Error ? error.message : "OIDC issuer is invalid",
          });
          return z.NEVER;
        }
      }),
    providerSubject: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(120),
    organizationSlug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
    organizationName: z.string().trim().min(1).max(120),
  })
  .strict();

const BootstrapTokenInputSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    identityIssuer: z
      .string()
      .max(2_048)
      .transform((value, context) => {
        try {
          return canonicalizeOidcIssuer(value);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              error instanceof Error ? error.message : "OIDC issuer is invalid",
          });
          return z.NEVER;
        }
      }),
    providerSubject: z.string().trim().min(1).max(256),
    organizationSlug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
    scopes: z.array(z.enum(["pack:read", "pack:publish"])).min(1),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

function canonicalNow(clock: () => Date): string {
  const value = clock();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Registry runtime clock returned an invalid Date");
  }
  return value.toISOString();
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when OIDC is configured`);
  return value;
}

function requiredSecretEnvironment(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): string {
  const value = optionalSecretEnvironment(env, valueName, fileName);
  if (value === undefined) {
    throw new Error(`Configure exactly one of ${valueName} or ${fileName}`);
  }
  return value;
}

function optionalSecretEnvironment(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): string | undefined {
  assertExclusiveSecretEnvironment(env, valueName, fileName);
  const direct = env[valueName];
  if (direct !== undefined && direct.length > 0) return direct;
  const filename = env[fileName]?.trim();
  return filename ? readSecretFile(filename, fileName) : undefined;
}

function assertExclusiveSecretEnvironment(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): void {
  const directConfigured = (env[valueName]?.length ?? 0) > 0;
  const fileConfigured = (env[fileName]?.trim().length ?? 0) > 0;
  if (directConfigured && fileConfigured) {
    throw new Error(`Configure exactly one of ${valueName} or ${fileName}`);
  }
}

function readSecretFile(filename: string, environmentName: string): string {
  const target = path.resolve(filename);
  const expected = fs.lstatSync(target);
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.size > MAX_SECRET_FILE_BYTES
  ) {
    throw new Error(
      `${environmentName} must reference a regular file no larger than 64 KiB`,
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new Error(`${environmentName} file changed during secure open`);
    }
    if (opened.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(`${environmentName} file exceeds 64 KiB`);
    }
    const bytes = readBoundedFile(descriptor, MAX_SECRET_FILE_BYTES);
    const afterRead = fs.fstatSync(descriptor);
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`${environmentName} file changed during read`);
    }
    let value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      throw new Error(`${environmentName} file must contain valid UTF-8`);
    }
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (value.length === 0) {
      throw new Error(`${environmentName} file must not be empty`);
    }
    if (value.includes("\u0000")) {
      throw new Error(`${environmentName} file must not contain NUL bytes`);
    }
    return value;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedFile(descriptor: number, maximumBytes: number): Buffer {
  const result = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < result.length) {
    const read = fs.readSync(
      descriptor,
      result,
      offset,
      result.length - offset,
      null,
    );
    if (read === 0) break;
    offset += read;
  }
  if (offset > maximumBytes) {
    throw new Error("Registry secret file exceeds the maximum size");
  }
  return result.subarray(0, offset);
}

function splitEnvironmentList(value: string): string[] {
  const values = value.split(",").map((entry) => entry.trim());
  if (
    values.some((entry) => entry === "") ||
    new Set(values).size !== values.length
  ) {
    throw new Error("OIDC comma-separated values must be unique and non-empty");
  }
  return values;
}

function readLocalJwks(filename: string): JSONWebKeySet {
  const target = path.resolve(filename);
  const expected = fs.lstatSync(target);
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.size > 1024 * 1024
  ) {
    throw new Error(
      "OIDC JWKS file must be a regular file no larger than 1 MiB",
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const current = fs.fstatSync(descriptor);
    if (
      !current.isFile() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error("OIDC JWKS file changed during read");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    return JSON.parse(raw) as JSONWebKeySet;
  } catch (error) {
    throw new Error("OIDC JWKS file is not valid JSON", { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
