import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGISTRY_PERMISSIONS,
  REGISTRY_ROLES,
  type ApiTokenRecord,
  type RegistryPermission,
  type RegistryRole,
} from "./registry-auth.js";
import { type RegistryReleaseCursorPosition } from "./registry-domain.js";
import {
  PublicPackDiscoveryDocumentSchema,
  emptyPublicPackDiscoveryDocument,
  normalizePublicPackDiscoveryFilter,
  type PublicPackDiscoveryDocument,
  type PublicPackDiscoveryFilterInput,
} from "./registry-search.js";

const MAX_PUBLIC_PAGE_READ_LIMIT = 101;

type JsonPrimitive = string | number | boolean | null;
export type RegistryJsonValue =
  JsonPrimitive | RegistryJsonValue[] | { [key: string]: RegistryJsonValue };
export type RegistryJsonObject = { [key: string]: RegistryJsonValue };

interface RegistrySqlResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface RegistrySqlExecutor {
  query(sql: string, values?: unknown[]): Promise<RegistrySqlResult>;
}

export interface RegistrySqlConnection extends RegistrySqlExecutor {
  release(): void;
}

export interface RegistrySqlPool extends RegistrySqlExecutor {
  connect(): Promise<RegistrySqlConnection>;
}

export interface RegistryMigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface RegistryMigrationOptions {
  readonly directory?: string;
  /**
   * Optional login role used by the long-running Registry process. When set,
   * the migrator reconciles least-privilege DML grants after every migration
   * and keeps the checksum ledger read-only to that role.
   */
  readonly runtimeRole?: string;
}

export class RegistryMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryMigrationError";
  }
}

export class RegistryStorageConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryStorageConflictError";
  }
}

export class RegistryStorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStorageNotFoundError";
  }
}

export class RegistryStorageForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStorageForbiddenError";
  }
}

export class RegistryStorageTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStorageTransitionError";
  }
}

export interface StoredRegistryUser {
  readonly id: string;
  readonly issuer: string;
  readonly identity_issuer: string | null;
  readonly subject: string;
  readonly display_name: string;
  readonly status: "active" | "suspended";
  readonly created_at: string;
}

export interface StoredRegistryOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly owner_user_id: string;
  readonly plan: "free" | "team" | "enterprise";
  readonly two_person_approval: boolean;
  readonly created_at: string;
}

export interface StoredRegistryMembership {
  readonly org_id: string;
  readonly user_id: string;
  readonly role: RegistryRole;
  readonly created_at: string;
}

export interface StoredRegistryPackage {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface StoredPublicRegistryPackageSearchHit
  extends StoredRegistryPackage {
  readonly latest_version: string | null;
  readonly discovery_available: boolean;
  readonly discovery: PublicPackDiscoveryDocument;
}

export type StoredRegistryReleaseStatus =
  "pending" | "published" | "rejected" | "yanked";

export interface StoredRegistryRelease {
  readonly id: string;
  readonly org_id: string;
  readonly package_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly status: StoredRegistryReleaseStatus;
  readonly artifact_integrity: string;
  readonly artifact: RegistryJsonObject;
  readonly manifest: RegistryJsonObject;
  readonly provenance: RegistryJsonObject;
  readonly submitted_by: string;
  readonly created_at: string;
  readonly published_at: string | null;
  readonly rejected_at: string | null;
  readonly rejection_reason: string | null;
  readonly yanked_at: string | null;
  readonly yank_reason: string | null;
  readonly approval_count: number;
}

export interface StoredRegistryReleaseApproval {
  readonly id: string;
  readonly release_id: string;
  readonly reviewer_user_id: string;
  readonly decision: "approved" | "rejected";
  readonly created_at: string;
}

export interface PublicRegistryPackagePageQuery {
  readonly query: string;
  readonly filters?: PublicPackDiscoveryFilterInput;
  readonly afterName?: string;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface PublicRegistryReleasePageQuery {
  readonly afterVersion?: string;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface RegistryTokenPageQuery {
  readonly afterCreatedAt?: string;
  readonly afterId?: string;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface RegistryTextPageQuery {
  readonly after?: string;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface RegistryReleasePageQuery {
  readonly packageName?: string;
  readonly after?: RegistryReleaseCursorPosition;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface RegistryAuditPageQuery {
  readonly afterSequence?: number;
  /** Includes the one-row lookahead used to decide whether a next cursor exists. */
  readonly limit: number;
}

export interface StoredRegistryAuditEvent {
  readonly sequence: number;
  readonly event_id: string;
  readonly request_id: string;
  readonly org_id: string;
  readonly actor_id: string | null;
  readonly actor_kind: "human" | "service" | "system";
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly metadata: RegistryJsonObject;
  readonly occurred_at: string;
}

export interface StoredRegistryApiToken extends ApiTokenRecord {}

export interface InsertRegistryUserInput {
  readonly id: string;
  readonly issuer: string;
  readonly identity_issuer?: string | null;
  readonly subject: string;
  readonly display_name: string;
  readonly created_at: string;
}

export interface EnsuredRegistryUser {
  readonly user: StoredRegistryUser;
  readonly created: boolean;
}

export interface CreateRegistryOrganizationInput {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly owner_user_id: string;
  readonly plan?: "free" | "team" | "enterprise";
  /** Compatibility input; Registry approval safety cannot be disabled. */
  readonly two_person_approval?: true;
  readonly created_at: string;
}

export interface AddRegistryMembershipInput {
  readonly org_id: string;
  readonly user_id: string;
  readonly role: RegistryRole;
  readonly created_at: string;
}

export interface CreateRegistryPackageInput {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description?: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface CreateRegistryReleaseInput {
  readonly id: string;
  readonly org_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly artifact_integrity: string;
  readonly artifact: RegistryJsonObject;
  readonly manifest: RegistryJsonObject;
  readonly provenance: RegistryJsonObject;
  readonly discovery: PublicPackDiscoveryDocument;
  readonly submitted_by: string;
  readonly created_at: string;
}

export interface ApproveRegistryReleaseInput {
  readonly org_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly reviewer_user_id: string;
  readonly request_id: string;
  readonly approved_at: string;
  readonly approval_id?: string;
  readonly approval_audit_event_id?: string;
  readonly published_audit_event_id?: string;
}

export interface RejectRegistryReleaseInput {
  readonly org_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly reviewer_user_id: string;
  readonly reason: string;
  readonly request_id: string;
  readonly rejected_at: string;
  readonly approval_id?: string;
  readonly audit_event_id?: string;
}

export interface YankRegistryReleaseInput {
  readonly org_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly reviewer_user_id: string;
  readonly reason: string;
  readonly request_id: string;
  readonly yanked_at: string;
  readonly audit_event_id?: string;
}

export interface AppendRegistryAuditEventInput {
  readonly event_id: string;
  readonly request_id: string;
  readonly org_id: string;
  readonly actor_id: string | null;
  readonly actor_kind: "human" | "service" | "system";
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly metadata: RegistryJsonObject;
  readonly occurred_at: string;
}

export interface InsertRegistryApiTokenInput {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly sha256: string;
  readonly prefix: string;
  readonly scopes: readonly RegistryPermission[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface PostgresRegistryRepositoryOptions {
  readonly idFactory?: () => string;
}

const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const MIGRATION_FILE = /^\d{3}_[a-z0-9][a-z0-9_-]*\.sql$/;
const REGISTRY_MIGRATION_ADVISORY_LOCK_KEYS = [
  0x5069744c, // "PitL"
  0x6f72654d, // "oreM"
] as const;
const REGISTRY_RUNTIME_PRIVILEGE_RESET_SQL = Object.freeze([
  "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM pitlore_runtime",
  "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM pitlore_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM pitlore_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM pitlore_runtime",
  "REVOKE CREATE ON SCHEMA public FROM pitlore_runtime",
  "GRANT USAGE ON SCHEMA public TO pitlore_runtime",
]);
const REGISTRY_RUNTIME_PRIVILEGE_GRANT_SQL = Object.freeze([
  "GRANT SELECT ON TABLE registry_schema_migrations TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_users TO pitlore_runtime",
  "GRANT UPDATE (identity_issuer) ON TABLE registry_users TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_organizations TO pitlore_runtime",
  "GRANT UPDATE (owner_user_id) ON TABLE registry_organizations TO pitlore_runtime",
  "GRANT SELECT, INSERT, DELETE ON TABLE registry_memberships TO pitlore_runtime",
  "GRANT UPDATE (role) ON TABLE registry_memberships TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_api_tokens TO pitlore_runtime",
  "GRANT UPDATE (revoked_at) ON TABLE registry_api_tokens TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_packages TO pitlore_runtime",
  "GRANT UPDATE (discovery_release_id) ON TABLE registry_packages TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_releases TO pitlore_runtime",
  "GRANT UPDATE (status, published_at, rejected_at, rejection_reason, yanked_at, yank_reason) ON TABLE registry_releases TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_release_discovery TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_release_discovery_facets TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_release_approvals TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_audit_events TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_usage_events TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_usage_reservations TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_subscriptions TO pitlore_runtime",
  "GRANT UPDATE (provider, plan, status, provider_event_created_at, provider_event_id, updated_at) ON TABLE registry_subscriptions TO pitlore_runtime",
  "GRANT SELECT, INSERT ON TABLE registry_billing_webhook_events TO pitlore_runtime",
  "GRANT USAGE ON SEQUENCE registry_audit_events_sequence_seq TO pitlore_runtime",
]);
const REGISTRY_RUNTIME_PRIVILEGE_RECONCILIATION_SQL = [
  ...REGISTRY_RUNTIME_PRIVILEGE_RESET_SQL,
  ...REGISTRY_RUNTIME_PRIVILEGE_GRANT_SQL,
].join(";\n");
const WRITER_ROLES = new Set<RegistryRole>(["publisher", "admin", "owner"]);
const REVIEWER_ROLES = new Set<RegistryRole>(["admin", "owner"]);

/**
 * Apply versioned local SQL migrations and pin each applied file to its SHA-256.
 *
 * Migration SQL is loaded only from regular files in the configured directory.
 * Runtime/user values never enter these SQL strings; every repository query
 * below uses bound parameters.
 */
export async function applyRegistryMigrations(
  pool: RegistrySqlPool,
  options: RegistryMigrationOptions = {},
): Promise<RegistryMigrationResult> {
  const directory = await realpath(
    path.resolve(options.directory ?? DEFAULT_MIGRATION_DIRECTORY),
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new RegistryMigrationError("No registry migrations found");
  }
  const versionPrefixes = names.map((name) => name.slice(0, 3));
  if (new Set(versionPrefixes).size !== versionPrefixes.length) {
    throw new RegistryMigrationError(
      "Registry migration version prefixes must be unique",
    );
  }
  const reconcileRuntimePrivileges = options.runtimeRole !== undefined;
  if (options.runtimeRole !== undefined) {
    assertRegistryRuntimeRole(options.runtimeRole);
  }

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  let lockAcquired = false;
  let migrationFailed = false;
  let migrationFailure: unknown;
  let unlockFailed = false;
  let unlockFailure: unknown;
  try {
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
      ...REGISTRY_MIGRATION_ADVISORY_LOCK_KEYS,
    ]);
    lockAcquired = true;
    const migrationTable = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'registry_schema_migrations'`,
    );
    if (migrationTable.rows.length === 0) {
      await client.query(`
        CREATE TABLE registry_schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    }

    const history = await client.query(
      "SELECT name, checksum FROM registry_schema_migrations ORDER BY name",
    );
    const localNames = new Set(names);
    const appliedNames = history.rows.map((row) => String(row.name));
    for (const appliedName of appliedNames) {
      if (!MIGRATION_FILE.test(appliedName) || !localNames.has(appliedName)) {
        throw new RegistryMigrationError(
          "Applied registry migration file is missing from the migration directory",
        );
      }
    }
    const latestApplied = appliedNames.at(-1);
    if (
      latestApplied &&
      names.some(
        (name) =>
          !appliedNames.includes(name) && name.localeCompare(latestApplied) < 0,
      )
    ) {
      throw new RegistryMigrationError(
        "Registry migrations must be appended after all applied migrations",
      );
    }

    for (const name of names) {
      const filename = path.join(directory, name);
      const stats = await lstat(filename);
      const canonicalFilename = await realpath(filename);
      if (!stats.isFile() || path.dirname(canonicalFilename) !== directory) {
        throw new RegistryMigrationError(
          "Registry migration must be a regular file inside its migration directory",
        );
      }
      const source = await readFile(canonicalFilename, "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM registry_schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new RegistryMigrationError(
            "Applied registry migration checksum changed",
          );
        }
        skipped.push(name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(source);
        await client.query(
          "INSERT INTO registry_schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await rollbackOrThrow(client, error);
      }
    }
    if (reconcileRuntimePrivileges) {
      await client.query("BEGIN");
      try {
        await client.query(REGISTRY_RUNTIME_PRIVILEGE_RECONCILIATION_SQL);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackOrThrow(client, error);
      }
    }
  } catch (error) {
    migrationFailed = true;
    migrationFailure = error;
  } finally {
    try {
      if (lockAcquired) {
        const unlocked = await client.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
          [...REGISTRY_MIGRATION_ADVISORY_LOCK_KEYS],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          throw new RegistryMigrationError(
            "Registry migration advisory lock was not held during unlock",
          );
        }
      }
    } catch (error) {
      unlockFailed = true;
      unlockFailure = error;
    } finally {
      client.release();
    }
  }
  if (migrationFailed) {
    if (unlockFailed) {
      throw new AggregateError(
        [migrationFailure, unlockFailure],
        "Registry migration and advisory unlock both failed",
      );
    }
    throw migrationFailure;
  }
  if (unlockFailed) {
    throw unlockFailure;
  }
  return Object.freeze({
    applied: Object.freeze(applied),
    skipped: Object.freeze(skipped),
  });
}

function assertRegistryRuntimeRole(role: string): void {
  if (role !== "pitlore_runtime") {
    throw new RegistryMigrationError(
      "Registry runtime privilege reconciliation only supports pitlore_runtime",
    );
  }
}

/**
 * Append the bounded, normalized lookup rows for one immutable discovery
 * snapshot. Only placeholder structure is generated here; every release,
 * package, dimension, and value remains a bound SQL parameter.
 */
export async function appendRegistryReleaseDiscoveryFacets(
  database: RegistrySqlExecutor,
  releaseId: string,
  packageId: string,
  input: PublicPackDiscoveryDocument,
): Promise<void> {
  assertNonEmpty(releaseId, "release id");
  assertNonEmpty(packageId, "package id");
  const discovery = PublicPackDiscoveryDocumentSchema.parse(input);
  const facets = [
    ...discovery.languages.map((value) => ({
      dimension: "language",
      value,
    })),
    ...discovery.ecosystems.map((value) => ({
      dimension: "ecosystem",
      value,
    })),
    ...discovery.tags.map((value) => ({ dimension: "tag", value })),
  ];
  if (facets.length === 0) return;

  const values: unknown[] = [releaseId, packageId];
  const placeholders = facets.map((facet, index) => {
    const dimensionParameter = index * 2 + 3;
    values.push(facet.dimension, facet.value);
    return `($1, $2, $${dimensionParameter}, $${dimensionParameter + 1})`;
  });
  await database.query(
    `INSERT INTO registry_release_discovery_facets
       (release_id, package_id, dimension, value)
     VALUES ${placeholders.join(",\n            ")}`,
    values,
  );
}

/**
 * Tenant-scoped PostgreSQL persistence adapter for the self-hosted Registry
 * MVP. Migrations provide RLS depth defence, but this adapter does not claim
 * production backup, HA, hosted operations, or third-party security assurance.
 *
 * Audit records expose append/list only. Release payload columns are written
 * exactly once; lifecycle methods update state columns only.
 */
export class PostgresRegistryRepository {
  readonly #database: RegistrySqlExecutor;
  readonly #pool: RegistrySqlPool | null;
  readonly #idFactory: () => string;
  readonly #insideTransaction: boolean;

  constructor(
    database: RegistrySqlExecutor,
    options: PostgresRegistryRepositoryOptions = {},
    insideTransaction = false,
  ) {
    this.#database = database;
    this.#pool = isRegistrySqlPool(database) ? database : null;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#insideTransaction = insideTransaction;
  }

  /**
   * Sets the row-level security tenant context for the current transaction.
   * Callable only inside a transaction because set_config(..., true) is
   * transaction-scoped; outside one the setting would silently not stick.
   */
  async setTenantContext(orgId: string): Promise<void> {
    assertNonEmpty(orgId, "organization id");
    if (!this.#insideTransaction) {
      throw new Error(
        "Registry tenant context can only be set inside a transaction",
      );
    }
    await this.#database.query(
      "SELECT set_config('pitlore.tenant_id', $1, true)",
      [orgId],
    );
  }

  /**
   * Runs work in a transaction with the row-level security tenant context set
   * to one organization. Org-scoped reads and writes must use this so RLS
   * policies on real PostgreSQL see the tenant; without context they fail
   * closed to zero rows for the non-owner runtime role.
   */
  async tenantTransaction<T>(
    orgId: string,
    work: (repository: PostgresRegistryRepository) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (repository) => {
      await repository.setTenantContext(orgId);
      return work(repository);
    });
  }

  async transaction<T>(
    work: (repository: PostgresRegistryRepository) => Promise<T>,
  ): Promise<T> {
    if (this.#insideTransaction) return work(this);
    if (!this.#pool) {
      throw new Error("Registry transaction requires a PostgreSQL pool");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const repository = new PostgresRegistryRepository(
        client,
        { idFactory: this.#idFactory },
        true,
      );
      const result = await work(repository);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return rollbackOrThrow(client, error);
    } finally {
      client.release();
    }
  }

  async insertUser(
    input: InsertRegistryUserInput,
  ): Promise<StoredRegistryUser> {
    assertNonEmpty(input.id, "user id");
    assertNonEmpty(input.issuer, "issuer");
    assertNonEmpty(input.subject, "subject");
    assertNonEmpty(input.display_name, "display name");
    assertTimestamp(input.created_at, "created_at");
    assertOptionalIdentityIssuer(input.identity_issuer);
    try {
      const result = await this.#database.query(
        `INSERT INTO registry_users
           (id, issuer, identity_issuer, subject, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, issuer, identity_issuer, subject, display_name, status, created_at`,
        [
          input.id,
          input.issuer,
          input.identity_issuer ?? null,
          input.subject,
          input.display_name,
          input.created_at,
        ],
      );
      return mapUser(requireSingleRow(result, "inserted user"));
    } catch (error) {
      throwConflictIfUnique(error, "Registry user already exists");
    }
  }

  async ensureUserByExternalIdentity(
    input: InsertRegistryUserInput,
  ): Promise<EnsuredRegistryUser> {
    assertNonEmpty(input.id, "user id");
    assertNonEmpty(input.issuer, "issuer");
    assertNonEmpty(input.subject, "subject");
    assertNonEmpty(input.display_name, "display name");
    assertTimestamp(input.created_at, "created_at");
    assertOptionalIdentityIssuer(input.identity_issuer);
    const inserted = await this.#database.query(
      `INSERT INTO registry_users
         (id, issuer, identity_issuer, subject, display_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (issuer, subject) DO NOTHING
       RETURNING id, issuer, identity_issuer, subject, display_name, status, created_at`,
      [
        input.id,
        input.issuer,
        input.identity_issuer ?? null,
        input.subject,
        input.display_name,
        input.created_at,
      ],
    );
    if (inserted.rows[0]) {
      return { user: mapUser(inserted.rows[0]), created: true };
    }
    const existing = await this.getUserByExternalIdentity(
      input.issuer,
      input.subject,
    );
    if (!existing) {
      throw new RegistryStorageConflictError(
        "Registry external identity could not be provisioned",
      );
    }
    const user = input.identity_issuer
      ? await this.bindUserIdentityIssuer(existing.id, input.identity_issuer)
      : existing;
    return { user, created: false };
  }

  async bindUserIdentityIssuer(
    userId: string,
    identityIssuer: string,
  ): Promise<StoredRegistryUser> {
    assertNonEmpty(userId, "user id");
    assertOptionalIdentityIssuer(identityIssuer);
    const result = await this.#database.query(
      `UPDATE registry_users
          SET identity_issuer = $2
        WHERE id = $1
          AND (identity_issuer IS NULL OR identity_issuer = $2)
        RETURNING id, issuer, identity_issuer, subject, display_name, status, created_at`,
      [userId, identityIssuer],
    );
    if (result.rows[0]) return mapUser(result.rows[0]);
    const existing = await this.getUser(userId);
    if (!existing)
      throw new RegistryStorageNotFoundError("Registry user not found");
    throw new RegistryStorageConflictError(
      "Registry user is bound to a different identity issuer",
    );
  }

  async getUser(userId: string): Promise<StoredRegistryUser | null> {
    assertNonEmpty(userId, "user id");
    const result = await this.#database.query(
      `SELECT id, issuer, identity_issuer, subject, display_name, status, created_at
         FROM registry_users
        WHERE id = $1`,
      [userId],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByExternalIdentity(
    issuer: string,
    subject: string,
  ): Promise<StoredRegistryUser | null> {
    assertNonEmpty(issuer, "issuer");
    assertNonEmpty(subject, "subject");
    const result = await this.#database.query(
      `SELECT id, issuer, identity_issuer, subject, display_name, status, created_at
         FROM registry_users
        WHERE issuer = $1 AND subject = $2`,
      [issuer, subject],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByVerifiedExternalIdentity(
    issuer: string,
    identityIssuer: string,
    subject: string,
  ): Promise<StoredRegistryUser | null> {
    assertNonEmpty(issuer, "issuer");
    assertOptionalIdentityIssuer(identityIssuer);
    assertNonEmpty(subject, "subject");
    const result = await this.#database.query(
      `SELECT id, issuer, identity_issuer, subject, display_name, status, created_at
         FROM registry_users
        WHERE issuer = $1 AND identity_issuer = $2 AND subject = $3`,
      [issuer, identityIssuer, subject],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createOrganization(
    input: CreateRegistryOrganizationInput,
  ): Promise<StoredRegistryOrganization> {
    validateOrganizationInput(input);
    return this.#atomic(async (repository) => {
      let organization: StoredRegistryOrganization;
      try {
        const result = await repository.#database.query(
          `INSERT INTO registry_organizations
             (id, slug, name, owner_user_id, plan, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, slug, name, owner_user_id, plan,
                     two_person_approval, created_at`,
          [
            input.id,
            input.slug,
            input.name,
            input.owner_user_id,
            input.plan ?? "free",
            input.created_at,
          ],
        );
        organization = mapOrganization(
          requireSingleRow(result, "created organization"),
        );
      } catch (error) {
        throwConflictIfUnique(error, "Registry organization already exists");
      }
      await repository.addMember({
        org_id: organization.id,
        user_id: organization.owner_user_id,
        role: "owner",
        created_at: organization.created_at,
      });
      return organization;
    });
  }

  async getOrganization(
    orgId: string,
  ): Promise<StoredRegistryOrganization | null> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT id, slug, name, owner_user_id, plan,
              two_person_approval, created_at
         FROM registry_organizations
        WHERE id = $1`,
      [orgId],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async lockOrganization(
    orgId: string,
  ): Promise<StoredRegistryOrganization | null> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT id, slug, name, owner_user_id, plan,
              two_person_approval, created_at
         FROM registry_organizations
        WHERE id = $1
        FOR UPDATE`,
      [orgId],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async getOrganizationBySlug(
    slug: string,
  ): Promise<StoredRegistryOrganization | null> {
    assertNonEmpty(slug, "organization slug");
    const result = await this.#database.query(
      `SELECT id, slug, name, owner_user_id, plan,
              two_person_approval, created_at
         FROM registry_organizations
        WHERE slug = $1`,
      [slug],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async getEffectiveSubscriptionPlan(
    orgId: string,
  ): Promise<"free" | "team" | "enterprise"> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT plan, status
         FROM registry_subscriptions
        WHERE org_id = $1`,
      [orgId],
    );
    const row = result.rows[0];
    if (!row || row.status === "canceled") return "free";
    if (
      row.plan !== "free" &&
      row.plan !== "team" &&
      row.plan !== "enterprise"
    ) {
      throw new Error("Registry subscription plan is invalid");
    }
    return row.plan;
  }

  async addMember(
    input: AddRegistryMembershipInput,
  ): Promise<StoredRegistryMembership> {
    assertNonEmpty(input.org_id, "organization id");
    assertNonEmpty(input.user_id, "user id");
    assertRegistryRole(input.role);
    assertTimestamp(input.created_at, "created_at");
    try {
      const result = await this.#database.query(
        `INSERT INTO registry_memberships (org_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING org_id, user_id, role, created_at`,
        [input.org_id, input.user_id, input.role, input.created_at],
      );
      return mapMembership(requireSingleRow(result, "added member"));
    } catch (error) {
      throwConflictIfUnique(error, "Registry membership already exists");
    }
  }

  async getMember(
    orgId: string,
    userId: string,
  ): Promise<StoredRegistryMembership | null> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(userId, "user id");
    const result = await this.#database.query(
      `SELECT org_id, user_id, role, created_at
         FROM registry_memberships
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async listMembers(orgId: string): Promise<StoredRegistryMembership[]> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT org_id, user_id, role, created_at
         FROM registry_memberships
        WHERE org_id = $1
        ORDER BY user_id`,
      [orgId],
    );
    return result.rows.map(mapMembership);
  }

  async listMemberPage(
    orgId: string,
    page: RegistryTextPageQuery,
  ): Promise<StoredRegistryMembership[]> {
    assertNonEmpty(orgId, "organization id");
    assertPageReadLimit(page.limit);
    if (page.after !== undefined) assertNonEmpty(page.after, "member cursor");
    const result = await this.#database.query(
      `SELECT org_id, user_id, role, created_at
         FROM registry_memberships
        WHERE org_id = $1
          AND ($2::text IS NULL OR user_id > $2)
        ORDER BY user_id
        LIMIT $3`,
      [orgId, page.after ?? null, page.limit],
    );
    return result.rows.map(mapMembership);
  }

  async updateMemberRole(
    orgId: string,
    userId: string,
    role: RegistryRole,
  ): Promise<StoredRegistryMembership> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(userId, "user id");
    assertRegistryRole(role);
    const result = await this.#database.query(
      `UPDATE registry_memberships
          SET role = $3
        WHERE org_id = $1 AND user_id = $2
        RETURNING org_id, user_id, role, created_at`,
      [orgId, userId, role],
    );
    if (result.rows.length === 0) {
      throw new RegistryStorageNotFoundError("Registry member not found");
    }
    return mapMembership(requireSingleRow(result, "updated member"));
  }

  async removeMember(
    orgId: string,
    userId: string,
  ): Promise<StoredRegistryMembership> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(userId, "user id");
    const result = await this.#database.query(
      `DELETE FROM registry_memberships
        WHERE org_id = $1 AND user_id = $2
        RETURNING org_id, user_id, role, created_at`,
      [orgId, userId],
    );
    if (result.rows.length === 0) {
      throw new RegistryStorageNotFoundError("Registry member not found");
    }
    return mapMembership(requireSingleRow(result, "removed member"));
  }

  async transferOrganizationOwner(
    orgId: string,
    ownerUserId: string,
  ): Promise<StoredRegistryOrganization> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(ownerUserId, "owner user id");
    return this.#atomic(async (repository) => {
      const organization = await repository.lockOrganization(orgId);
      if (!organization) {
        throw new RegistryStorageNotFoundError(
          "Registry organization not found",
        );
      }
      const member = await repository.getMember(orgId, ownerUserId);
      if (!member || member.role !== "owner") {
        throw new RegistryStorageConflictError(
          "Organization owner must be an owner member",
        );
      }
      const result = await repository.#database.query(
        `UPDATE registry_organizations
            SET owner_user_id = $2
          WHERE id = $1
          RETURNING id, slug, name, owner_user_id, plan,
                    two_person_approval, created_at`,
        [orgId, ownerUserId],
      );
      return mapOrganization(
        requireSingleRow(result, "transferred organization owner"),
      );
    });
  }

  async insertApiToken(
    input: InsertRegistryApiTokenInput,
  ): Promise<StoredRegistryApiToken> {
    validateApiTokenInput(input);
    try {
      const result = await this.#database.query(
        `INSERT INTO registry_api_tokens
           (id, user_id, org_id, token_hash, prefix, scopes, expires_at,
            revoked_at, created_at)
         SELECT $1, m.user_id, m.org_id, $4, $5, $6::text[],
                $7::timestamptz, $8::timestamptz, $9::timestamptz
           FROM registry_memberships AS m
          WHERE m.org_id = $2 AND m.user_id = $3
         RETURNING id, user_id, org_id, token_hash, prefix, scopes,
                   expires_at, revoked_at, created_at`,
        [
          input.tokenId,
          input.tenantId,
          input.subjectId,
          input.sha256,
          input.prefix,
          [...input.scopes],
          input.expiresAt,
          input.revokedAt,
          input.createdAt,
        ],
      );
      if (result.rows.length === 0) {
        throw new RegistryStorageForbiddenError(
          "API token subject must be an organization member",
        );
      }
      return mapApiToken(requireSingleRow(result, "inserted API token"));
    } catch (error) {
      throwConflictIfUnique(error, "Registry API token already exists");
    }
  }

  async listApiTokens(orgId?: string): Promise<StoredRegistryApiToken[]> {
    if (orgId !== undefined) assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT id, user_id, org_id, token_hash, prefix, scopes,
              expires_at, revoked_at, created_at
         FROM registry_api_tokens
        WHERE ($1::text IS NULL OR org_id = $1)
        ORDER BY created_at, id`,
      [orgId ?? null],
    );
    return result.rows.map(mapApiToken);
  }

  async listApiTokenPage(
    orgId: string,
    page: RegistryTokenPageQuery,
  ): Promise<StoredRegistryApiToken[]> {
    assertNonEmpty(orgId, "organization id");
    assertPageReadLimit(page.limit);
    if ((page.afterCreatedAt === undefined) !== (page.afterId === undefined)) {
      throw new Error("Registry API token cursor position is incomplete");
    }
    if (page.afterCreatedAt !== undefined) {
      assertTimestamp(page.afterCreatedAt, "API token cursor created_at");
      assertNonEmpty(page.afterId!, "API token cursor id");
    }
    const result = await this.#database.query(
      `SELECT id, user_id, org_id, token_hash, prefix, scopes,
              expires_at, revoked_at, created_at
         FROM registry_api_tokens
        WHERE org_id = $1
          AND (
            $2::timestamptz IS NULL
            OR created_at > $2::timestamptz
            OR (created_at = $2::timestamptz AND id > $3)
          )
        ORDER BY created_at, id
        LIMIT $4`,
      [orgId, page.afterCreatedAt ?? null, page.afterId ?? null, page.limit],
    );
    return result.rows.map(mapApiToken);
  }

  async getActiveApiTokenByHash(
    sha256: string,
  ): Promise<StoredRegistryApiToken | null> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("API token lookup hash must be lowercase SHA-256");
    }
    const result = await this.#database.query(
      `SELECT t.id, t.user_id, t.org_id, t.token_hash, t.prefix, t.scopes,
              t.expires_at, t.revoked_at, t.created_at
         FROM registry_api_tokens AS t
         JOIN registry_users AS u ON u.id = t.user_id
        WHERE t.token_hash = $1
          AND u.status = 'active'`,
      [sha256],
    );
    return result.rows[0] ? mapApiToken(result.rows[0]) : null;
  }

  async revokeApiToken(
    orgId: string,
    tokenId: string,
    revokedAt: string,
  ): Promise<StoredRegistryApiToken> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(tokenId, "token id");
    assertTimestamp(revokedAt, "revoked_at");
    const result = await this.#database.query(
      `UPDATE registry_api_tokens
          SET revoked_at = COALESCE(revoked_at, $3)
        WHERE org_id = $1 AND id = $2
        RETURNING id, user_id, org_id, token_hash, prefix, scopes,
                  expires_at, revoked_at, created_at`,
      [orgId, tokenId, revokedAt],
    );
    if (result.rows.length === 0) {
      throw new RegistryStorageNotFoundError("Registry API token not found");
    }
    return mapApiToken(requireSingleRow(result, "revoked API token"));
  }

  async revokeApiTokensForSubject(
    orgId: string,
    userId: string,
    revokedAt: string,
  ): Promise<StoredRegistryApiToken[]> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(userId, "user id");
    assertTimestamp(revokedAt, "revoked_at");
    const result = await this.#database.query(
      `UPDATE registry_api_tokens
          SET revoked_at = $3
        WHERE org_id = $1
          AND user_id = $2
          AND revoked_at IS NULL
        RETURNING id, user_id, org_id, token_hash, prefix, scopes,
                  expires_at, revoked_at, created_at`,
      [orgId, userId, revokedAt],
    );
    return result.rows.map(mapApiToken);
  }

  async createPackage(
    input: CreateRegistryPackageInput,
  ): Promise<StoredRegistryPackage> {
    validatePackageInput(input);
    try {
      const result = await this.#database.query(
        `INSERT INTO registry_packages
           (id, org_id, name, visibility, description, created_by, created_at)
         SELECT $1, m.org_id, $3, $4, $5, m.user_id, $7::timestamptz
           FROM registry_memberships AS m
          WHERE m.org_id = $2
            AND m.user_id = $6
            AND m.role IN ('publisher', 'admin', 'owner')
         RETURNING id, org_id, name, visibility, description, created_by, created_at`,
        [
          input.id,
          input.org_id,
          input.name,
          input.visibility,
          input.description ?? "",
          input.created_by,
          input.created_at,
        ],
      );
      if (result.rows.length === 0) {
        throw new RegistryStorageForbiddenError(
          "Package creation requires publisher, admin, or owner membership",
        );
      }
      return mapPackage(requireSingleRow(result, "created package"));
    } catch (error) {
      throwConflictIfUnique(error, "Registry package already exists");
    }
  }

  async getPackage(
    orgId: string,
    name: string,
  ): Promise<StoredRegistryPackage | null> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(name, "package name");
    const result = await this.#database.query(
      `SELECT id, org_id, name, visibility, description, created_by, created_at
         FROM registry_packages
        WHERE org_id = $1 AND name = $2`,
      [orgId, name],
    );
    return result.rows[0] ? mapPackage(result.rows[0]) : null;
  }

  async listPackages(orgId: string): Promise<StoredRegistryPackage[]> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT id, org_id, name, visibility, description, created_by, created_at
         FROM registry_packages
        WHERE org_id = $1
        ORDER BY name`,
      [orgId],
    );
    return result.rows.map(mapPackage);
  }

  async listPackagePage(
    orgId: string,
    page: RegistryTextPageQuery,
  ): Promise<StoredRegistryPackage[]> {
    assertNonEmpty(orgId, "organization id");
    assertPageReadLimit(page.limit);
    if (page.after !== undefined) assertNonEmpty(page.after, "package cursor");
    const result = await this.#database.query(
      `SELECT id, org_id, name, visibility, description, created_by, created_at
         FROM registry_packages
        WHERE org_id = $1
          AND ($2::text IS NULL OR name > $2)
        ORDER BY name
        LIMIT $3`,
      [orgId, page.after ?? null, page.limit],
    );
    return result.rows.map(mapPackage);
  }

  async listPublicPackages(
    page: PublicRegistryPackagePageQuery,
  ): Promise<StoredPublicRegistryPackageSearchHit[]> {
    assertPageReadLimit(page.limit);
    const normalizedQuery = page.query.toLocaleLowerCase("en-US");
    const filters = normalizePublicPackDiscoveryFilter(page.filters);
    const afterName = page.afterName ?? null;
    const hasFacetFilters =
      filters.languages.length > 0 ||
      filters.ecosystems.length > 0 ||
      filters.tags.length > 0;
    const projectionSql = `SELECT p.id, p.org_id, p.name, p.visibility, p.description,
              p.created_by, p.created_at, r.version AS latest_version,
              d.release_id IS NOT NULL AS discovery_available,
              d.schema_version AS discovery_schema_version,
              d.description AS discovery_description,
              d.languages AS discovery_languages,
              d.ecosystems AS discovery_ecosystems,
              d.tags AS discovery_tags,
              d.lesson_count AS discovery_lesson_count`;
    const unfilteredSql = `${projectionSql}
         FROM registry_packages AS p
         LEFT JOIN registry_releases AS r
           ON r.id = p.discovery_release_id
          AND r.package_id = p.id
          AND r.status = 'published'
         LEFT JOIN registry_release_discovery AS d
           ON d.release_id = r.id
          AND d.package_id = p.id
        WHERE p.visibility = 'public'
          AND strpos(lower(p.name), $1) > 0
          AND ($2::text IS NULL OR p.name > $2)
        ORDER BY p.name
        LIMIT $3`;
    const filteredSql = `${projectionSql}
         FROM registry_packages AS p
         JOIN registry_releases AS r
           ON r.id = p.discovery_release_id
          AND r.package_id = p.id
          AND r.status = 'published'
         JOIN registry_release_discovery AS d
           ON d.release_id = r.id
          AND d.package_id = p.id
        WHERE p.visibility = 'public'
          AND strpos(lower(p.name), $1) > 0
          AND ($2::text IS NULL OR p.name > $2)
          AND (
            cardinality($3::text[]) = 0
            OR r.id IN (
              SELECT language_facet.release_id
                FROM registry_release_discovery_facets AS language_facet
               WHERE language_facet.dimension = 'language'
                 AND language_facet.value = ANY($3::text[])
            )
          )
          AND (
            cardinality($4::text[]) = 0
            OR r.id IN (
              SELECT ecosystem_facet.release_id
                FROM registry_release_discovery_facets AS ecosystem_facet
               WHERE ecosystem_facet.dimension = 'ecosystem'
                 AND ecosystem_facet.value = ANY($4::text[])
            )
          )
          AND (
            cardinality($5::text[]) = 0
            OR r.id IN (
              SELECT tag_facet.release_id
                FROM registry_release_discovery_facets AS tag_facet
               WHERE tag_facet.dimension = 'tag'
                 AND tag_facet.value = ANY($5::text[])
            )
          )
        ORDER BY p.name
        LIMIT $6`;
    const result = await this.#database.query(
      hasFacetFilters ? filteredSql : unfilteredSql,
      hasFacetFilters
        ? [
            normalizedQuery,
            afterName,
            filters.languages,
            filters.ecosystems,
            filters.tags,
            page.limit,
          ]
        : [normalizedQuery, afterName, page.limit],
    );
    return result.rows.map(mapPublicPackageSearchHit);
  }

  async getPublicPackage(name: string): Promise<StoredRegistryPackage | null> {
    assertNonEmpty(name, "package name");
    const result = await this.#database.query(
      `SELECT id, org_id, name, visibility, description, created_by, created_at
         FROM registry_packages
        WHERE name = $1 AND visibility = 'public'`,
      [name],
    );
    return result.rows[0] ? mapPackage(result.rows[0]) : null;
  }

  async createRelease(
    input: CreateRegistryReleaseInput,
  ): Promise<StoredRegistryRelease> {
    validateReleaseInput(input);
    const discovery = PublicPackDiscoveryDocumentSchema.parse(input.discovery);
    return this.#atomic(async (repository) => {
      try {
        const result = await repository.#database.query(
          `INSERT INTO registry_releases
             (id, package_id, version, status, artifact_integrity, artifact,
              manifest, provenance, submitted_by, created_at)
           SELECT $1, p.id, $4, 'pending', $5, $6::jsonb,
                  $7::jsonb, $8::jsonb, m.user_id, $10::timestamptz
             FROM registry_packages AS p
             JOIN registry_memberships AS m
               ON m.org_id = p.org_id
              AND m.user_id = $9
              AND m.role IN ('publisher', 'admin', 'owner')
            WHERE p.org_id = $2 AND p.name = $3
           RETURNING id, package_id`,
          [
            input.id,
            input.org_id,
            input.package_name,
            input.version,
            input.artifact_integrity,
            JSON.stringify(input.artifact),
            JSON.stringify(input.manifest),
            JSON.stringify(input.provenance),
            input.submitted_by,
            input.created_at,
          ],
        );
        if (result.rows.length === 0) {
          const registryPackage = await repository.getPackage(
            input.org_id,
            input.package_name,
          );
          if (!registryPackage) {
            throw new RegistryStorageNotFoundError("Registry package not found");
          }
          throw new RegistryStorageForbiddenError(
            "Release creation requires publisher, admin, or owner membership",
          );
        }
        const inserted = requireSingleRow(result, "created release identity");
        const releaseId = asString(inserted.id, "release id");
        const packageId = asString(inserted.package_id, "package id");
        await repository.#database.query(
          `INSERT INTO registry_release_discovery
             (release_id, package_id, schema_version, description, languages,
              ecosystems, tags, lesson_count, indexed_at)
           VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::text[], $8,
                   $9::timestamptz)`,
          [
            releaseId,
            packageId,
            discovery.version,
            discovery.description,
            discovery.languages,
            discovery.ecosystems,
            discovery.tags,
            discovery.lesson_count,
            input.created_at,
          ],
        );
        await appendRegistryReleaseDiscoveryFacets(
          repository.#database,
          releaseId,
          packageId,
          discovery,
        );
        const release = await repository.getRelease(
          input.org_id,
          input.package_name,
          input.version,
        );
        if (!release) {
          throw new Error("Inserted registry release could not be reloaded");
        }
        return release;
      } catch (error) {
        throwConflictIfUnique(
          error,
          "Registry release is immutable and already exists",
        );
      }
    });
  }

  async getRelease(
    orgId: string,
    packageName: string,
    version: string,
  ): Promise<StoredRegistryRelease | null> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(packageName, "package name");
    assertNonEmpty(version, "release version");
    const result = await this.#database.query(GET_RELEASE_SQL, [
      orgId,
      packageName,
      version,
    ]);
    return result.rows[0] ? mapRelease(result.rows[0]) : null;
  }

  async listReleases(
    orgId: string,
    packageName: string,
  ): Promise<StoredRegistryRelease[]> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(packageName, "package name");
    const result = await this.#database.query(LIST_RELEASES_SQL, [
      orgId,
      packageName,
    ]);
    return result.rows.map(mapRelease);
  }

  async listReleasePage(
    orgId: string,
    page: RegistryReleasePageQuery,
  ): Promise<StoredRegistryRelease[]> {
    assertNonEmpty(orgId, "organization id");
    assertPageReadLimit(page.limit);
    if (page.packageName !== undefined) {
      assertNonEmpty(page.packageName, "package name");
    }
    if (page.after !== undefined) {
      assertNonEmpty(page.after.packageName, "release cursor package name");
      assertNonEmpty(page.after.version, "release cursor version");
    }
    // selected_releases is referenced by both the approval-count CTE and the
    // final projection. PostgreSQL therefore materializes it by default; the
    // LIMIT remains an optimization fence before any approval aggregation.
    const result = await this.#database.query(
      [
        `WITH selected_releases AS (
         SELECT release.id, package.name AS package_name,
                release.semver_sort_key, release.semver_version_tie_key
           FROM (
             SELECT id, name
               FROM registry_packages
              WHERE org_id = $1
                AND ($2::text IS NULL OR name = $2)
                AND ($3::text IS NULL OR name >= $3)
              ORDER BY name ASC
           ) AS package
           CROSS JOIN LATERAL (
             SELECT r.id, r.semver_sort_key, r.semver_version_tie_key
               FROM registry_releases AS r
              WHERE r.package_id = package.id
                AND (
                  $3::text IS NULL
                  OR package.name > $3
                  OR (
                    package.name = $3
                    AND (
                      r.semver_sort_key < registry_semver_sort_key($4)
                      OR (
                        r.semver_sort_key = registry_semver_sort_key($4)
                        AND r.semver_version_tie_key < $4
                      )
                    )
                  )
                )
              ORDER BY r.semver_sort_key DESC,
                       r.semver_version_tie_key DESC
              LIMIT $5
           ) AS release
          ORDER BY package.name ASC, release.semver_sort_key DESC,
                   release.semver_version_tie_key DESC
          LIMIT $5
       ),`,
        SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL,
        SELECTED_RELEASE_COLUMNS_SQL,
        SELECTED_RELEASE_FROM_SQL,
        `ORDER BY selected.package_name ASC, selected.semver_sort_key DESC,
                  selected.semver_version_tie_key DESC`,
      ].join("\n"),
      [
        orgId,
        page.packageName ?? null,
        page.after?.packageName ?? null,
        page.after?.version ?? null,
        page.limit,
      ],
    );
    return result.rows.map(mapRelease);
  }

  async getPublicRelease(
    packageName: string,
    version: string,
  ): Promise<StoredRegistryRelease | null> {
    assertNonEmpty(packageName, "package name");
    assertNonEmpty(version, "release version");
    const result = await this.#database.query(
      [
        `WITH selected_releases AS (
         SELECT r.id
           FROM registry_releases AS r
           JOIN registry_packages AS p ON p.id = r.package_id
          WHERE p.name = $1
            AND p.visibility = 'public'
            AND r.version = $2
            AND r.status IN ('published', 'yanked')
       ),`,
        SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL,
        SELECTED_RELEASE_COLUMNS_SQL,
        SELECTED_RELEASE_FROM_SQL,
      ].join("\n"),
      [packageName, version],
    );
    return result.rows[0] ? mapRelease(result.rows[0]) : null;
  }

  async listPublicReleases(
    packageName: string,
    page: PublicRegistryReleasePageQuery,
  ): Promise<StoredRegistryRelease[]> {
    assertNonEmpty(packageName, "package name");
    assertPageReadLimit(page.limit);
    // As above, two references make the bounded selection a materialized CTE
    // on PostgreSQL while keeping the SQL executable in the pg-mem adapter.
    const result = await this.#database.query(
      [
        `WITH selected_releases AS (
         SELECT r.id, r.semver_sort_key, r.semver_version_tie_key
           FROM registry_releases AS r
           JOIN registry_packages AS p ON p.id = r.package_id
          WHERE p.name = $1
            AND p.visibility = 'public'
            AND r.status IN ('published', 'yanked')
            AND (
              $2::text IS NULL
              OR r.semver_sort_key < registry_semver_sort_key($2)
              OR (
                r.semver_sort_key = registry_semver_sort_key($2)
                AND r.semver_version_tie_key < $2
              )
            )
          ORDER BY r.semver_sort_key DESC, r.semver_version_tie_key DESC
          LIMIT $3
       ),`,
        SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL,
        SELECTED_RELEASE_COLUMNS_SQL,
        SELECTED_RELEASE_FROM_SQL,
        `ORDER BY selected.semver_sort_key DESC,
                  selected.semver_version_tie_key DESC`,
      ].join("\n"),
      [packageName, page.afterVersion ?? null, page.limit],
    );
    return result.rows.map(mapRelease);
  }

  async listReleaseApprovals(
    orgId: string,
    packageName: string,
    version: string,
  ): Promise<StoredRegistryReleaseApproval[]> {
    assertNonEmpty(orgId, "organization id");
    assertNonEmpty(packageName, "package name");
    assertNonEmpty(version, "release version");
    const result = await this.#database.query(
      `SELECT a.id, a.release_id, a.reviewer_user_id, a.decision, a.created_at
         FROM registry_release_approvals AS a
         JOIN registry_releases AS r ON r.id = a.release_id
         JOIN registry_packages AS p ON p.id = r.package_id
        WHERE p.org_id = $1 AND p.name = $2 AND r.version = $3
        ORDER BY a.created_at, a.id`,
      [orgId, packageName, version],
    );
    return result.rows.map(mapApproval);
  }

  async listReleaseApprovalsByReleaseIds(
    orgId: string,
    releaseIds: readonly string[],
  ): Promise<StoredRegistryReleaseApproval[]> {
    assertNonEmpty(orgId, "organization id");
    if (releaseIds.length === 0) return [];
    assertPageReadLimit(releaseIds.length);
    for (const releaseId of releaseIds) assertNonEmpty(releaseId, "release id");
    const result = await this.#database.query(
      `SELECT a.id, a.release_id, a.reviewer_user_id, a.decision, a.created_at
         FROM registry_release_approvals AS a
         JOIN registry_releases AS r ON r.id = a.release_id
        JOIN registry_packages AS p ON p.id = r.package_id
       WHERE p.org_id = $1
          AND a.release_id = ANY($2::text[])
       ORDER BY a.release_id, a.created_at, a.id`,
      [orgId, releaseIds],
    );
    return result.rows.map(mapApproval);
  }

  async approveRelease(
    input: ApproveRegistryReleaseInput,
  ): Promise<StoredRegistryRelease> {
    validateApprovalInput(input);
    return this.#atomic(async (repository) => {
      const locked = await repository.#database.query(
        `SELECT r.id, r.package_id, r.status, r.submitted_by
           FROM registry_releases AS r
           JOIN registry_packages AS p ON p.id = r.package_id
          WHERE p.org_id = $1 AND p.name = $2 AND r.version = $3
          FOR UPDATE`,
        [input.org_id, input.package_name, input.version],
      );
      const release = locked.rows[0];
      if (!release) {
        throw new RegistryStorageNotFoundError("Registry release not found");
      }
      if (release.status !== "pending") {
        throw new RegistryStorageTransitionError(
          "Only pending registry releases may be approved",
        );
      }
      if (release.submitted_by === input.reviewer_user_id) {
        throw new RegistryStorageForbiddenError(
          "Release submitter cannot approve their own release",
        );
      }
      const membership = await repository.getMember(
        input.org_id,
        input.reviewer_user_id,
      );
      if (!membership || !REVIEWER_ROLES.has(membership.role)) {
        throw new RegistryStorageForbiddenError(
          "Release approval requires admin or owner membership",
        );
      }

      const approvalId = input.approval_id ?? repository.#idFactory();
      try {
        await repository.#database.query(
          `INSERT INTO registry_release_approvals
             (id, release_id, reviewer_user_id, decision, created_at)
           VALUES ($1, $2, $3, 'approved', $4)`,
          [approvalId, release.id, input.reviewer_user_id, input.approved_at],
        );
      } catch (error) {
        throwConflictIfUnique(
          error,
          "Reviewer already decided this registry release",
        );
      }

      const countResult = await repository.#database.query(
        `SELECT count(*)::integer AS approval_count
           FROM registry_release_approvals
          WHERE release_id = $1 AND decision = 'approved'`,
        [release.id],
      );
      const approvalCount = asSafeInteger(
        countResult.rows[0]?.approval_count,
        "approval_count",
      );
      const published = approvalCount >= 2;
      if (published) {
        await repository.#database.query(
          `UPDATE registry_releases
              SET status = 'published', published_at = $2
            WHERE id = $1 AND status = 'pending'`,
          [release.id, input.approved_at],
        );
        await repository.#refreshPackageDiscoveryProjection(
          asString(release.package_id, "package id"),
        );
      }

      await repository.appendAuditEvent({
        event_id: input.approval_audit_event_id ?? repository.#idFactory(),
        request_id: input.request_id,
        org_id: input.org_id,
        actor_id: input.reviewer_user_id,
        actor_kind: "human",
        action: "release.approved",
        target_type: "release",
        target_id: asString(release.id, "release id"),
        metadata: {
          package_name: input.package_name,
          version: input.version,
          approval_count: approvalCount,
        },
        occurred_at: input.approved_at,
      });
      if (published) {
        await repository.appendAuditEvent({
          event_id: input.published_audit_event_id ?? repository.#idFactory(),
          request_id: input.request_id,
          org_id: input.org_id,
          actor_id: input.reviewer_user_id,
          actor_kind: "human",
          action: "release.published",
          target_type: "release",
          target_id: asString(release.id, "release id"),
          metadata: {
            package_name: input.package_name,
            version: input.version,
          },
          occurred_at: input.approved_at,
        });
      }

      const updated = await repository.getRelease(
        input.org_id,
        input.package_name,
        input.version,
      );
      if (!updated) {
        throw new Error("Approved registry release could not be reloaded");
      }
      return updated;
    });
  }

  async rejectRelease(
    input: RejectRegistryReleaseInput,
  ): Promise<StoredRegistryRelease> {
    validateRejectionInput(input);
    return this.#atomic(async (repository) => {
      const locked = await repository.#database.query(
        `SELECT r.id, r.status, r.submitted_by
           FROM registry_releases AS r
          WHERE r.id = (
            SELECT candidate.id
              FROM registry_releases AS candidate
              JOIN registry_packages AS p ON p.id = candidate.package_id
             WHERE p.org_id = $1 AND p.name = $2 AND candidate.version = $3
          )
          FOR UPDATE`,
        [input.org_id, input.package_name, input.version],
      );
      const release = locked.rows[0];
      if (!release) {
        throw new RegistryStorageNotFoundError("Registry release not found");
      }
      if (release.status !== "pending") {
        throw new RegistryStorageTransitionError(
          "Only pending registry releases may be rejected",
        );
      }
      if (release.submitted_by === input.reviewer_user_id) {
        throw new RegistryStorageForbiddenError(
          "Release submitter cannot reject their own release",
        );
      }
      const membership = await repository.getMember(
        input.org_id,
        input.reviewer_user_id,
      );
      if (!membership || !REVIEWER_ROLES.has(membership.role)) {
        throw new RegistryStorageForbiddenError(
          "Release rejection requires admin or owner membership",
        );
      }

      try {
        await repository.#database.query(
          `INSERT INTO registry_release_approvals
             (id, release_id, reviewer_user_id, decision, created_at)
           VALUES ($1, $2, $3, 'rejected', $4)`,
          [
            input.approval_id ?? repository.#idFactory(),
            release.id,
            input.reviewer_user_id,
            input.rejected_at,
          ],
        );
      } catch (error) {
        throwConflictIfUnique(
          error,
          "Reviewer already decided this registry release",
        );
      }
      const updated = await repository.#database.query(
        `UPDATE registry_releases
            SET status = 'rejected', rejected_at = $2, rejection_reason = $3
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [release.id, input.rejected_at, input.reason],
      );
      if (updated.rows.length !== 1) {
        throw new RegistryStorageTransitionError(
          "Registry release state changed during rejection",
        );
      }
      await repository.appendAuditEvent({
        event_id: input.audit_event_id ?? repository.#idFactory(),
        request_id: input.request_id,
        org_id: input.org_id,
        actor_id: input.reviewer_user_id,
        actor_kind: "human",
        action: "release.rejected",
        target_type: "release",
        target_id: asString(release.id, "release id"),
        metadata: {
          package_name: input.package_name,
          version: input.version,
          reason: input.reason,
        },
        occurred_at: input.rejected_at,
      });
      const result = await repository.getRelease(
        input.org_id,
        input.package_name,
        input.version,
      );
      if (!result)
        throw new Error("Rejected registry release could not be reloaded");
      return result;
    });
  }

  async yankRelease(
    input: YankRegistryReleaseInput,
  ): Promise<StoredRegistryRelease> {
    validateYankInput(input);
    return this.#atomic(async (repository) => {
      const locked = await repository.#database.query(
        `SELECT r.id, r.package_id, r.status
           FROM registry_releases AS r
           JOIN registry_packages AS p ON p.id = r.package_id
          WHERE p.org_id = $1 AND p.name = $2 AND r.version = $3
          FOR UPDATE`,
        [input.org_id, input.package_name, input.version],
      );
      const release = locked.rows[0];
      if (!release) {
        throw new RegistryStorageNotFoundError("Registry release not found");
      }
      if (release.status !== "published") {
        throw new RegistryStorageTransitionError(
          "Only published registry releases may be yanked",
        );
      }
      const membership = await repository.getMember(
        input.org_id,
        input.reviewer_user_id,
      );
      if (!membership || !REVIEWER_ROLES.has(membership.role)) {
        throw new RegistryStorageForbiddenError(
          "Release yank requires admin or owner membership",
        );
      }
      const updated = await repository.#database.query(
        `UPDATE registry_releases
            SET status = 'yanked', yanked_at = $2, yank_reason = $3
          WHERE id = $1 AND status = 'published'
          RETURNING id`,
        [release.id, input.yanked_at, input.reason],
      );
      if (updated.rows.length !== 1) {
        throw new RegistryStorageTransitionError(
          "Registry release state changed during yank",
        );
      }
      await repository.#refreshPackageDiscoveryProjection(
        asString(release.package_id, "package id"),
      );
      await repository.appendAuditEvent({
        event_id: input.audit_event_id ?? repository.#idFactory(),
        request_id: input.request_id,
        org_id: input.org_id,
        actor_id: input.reviewer_user_id,
        actor_kind: "human",
        action: "release.yanked",
        target_type: "release",
        target_id: asString(release.id, "release id"),
        metadata: {
          package_name: input.package_name,
          version: input.version,
          reason: input.reason,
        },
        occurred_at: input.yanked_at,
      });
      const result = await repository.getRelease(
        input.org_id,
        input.package_name,
        input.version,
      );
      if (!result)
        throw new Error("Yanked registry release could not be reloaded");
      return result;
    });
  }

  async #refreshPackageDiscoveryProjection(packageId: string): Promise<void> {
    assertNonEmpty(packageId, "package id");
    const latest = await this.#database.query(
      `SELECT r.id
         FROM registry_releases AS r
        WHERE r.package_id = $1
          AND r.status = 'published'
        ORDER BY r.semver_sort_key DESC,
                 r.semver_version_tie_key DESC
        LIMIT 1`,
      [packageId],
    );
    const latestReleaseId = latest.rows[0]
      ? asString(latest.rows[0].id, "release id")
      : null;
    const updated = await this.#database.query(
      `UPDATE registry_packages
          SET discovery_release_id = $2
        WHERE id = $1
        RETURNING id`,
      [packageId, latestReleaseId],
    );
    if (updated.rows.length !== 1) {
      throw new RegistryStorageNotFoundError("Registry package not found");
    }
  }

  async appendAuditEvent(
    input: AppendRegistryAuditEventInput,
  ): Promise<StoredRegistryAuditEvent> {
    validateAuditInput(input);
    try {
      const result = await this.#database.query(
        `INSERT INTO registry_audit_events
           (event_id, request_id, org_id, actor_id, actor_kind, action,
            target_type, target_id, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING sequence, event_id, request_id, org_id, actor_id, actor_kind,
                   action, target_type, target_id, metadata, occurred_at`,
        [
          input.event_id,
          input.request_id,
          input.org_id,
          input.actor_id,
          input.actor_kind,
          input.action,
          input.target_type,
          input.target_id,
          JSON.stringify(input.metadata),
          input.occurred_at,
        ],
      );
      return mapAuditEvent(requireSingleRow(result, "appended audit event"));
    } catch (error) {
      throwConflictIfUnique(error, "Registry audit event already exists");
    }
  }

  async listAuditEvents(orgId: string): Promise<StoredRegistryAuditEvent[]> {
    assertNonEmpty(orgId, "organization id");
    const result = await this.#database.query(
      `SELECT sequence, event_id, request_id, org_id, actor_id, actor_kind,
              action, target_type, target_id, metadata, occurred_at
         FROM registry_audit_events
        WHERE org_id = $1
        ORDER BY sequence`,
      [orgId],
    );
    return result.rows.map(mapAuditEvent);
  }

  async listAuditEventPage(
    orgId: string,
    page: RegistryAuditPageQuery,
  ): Promise<StoredRegistryAuditEvent[]> {
    assertNonEmpty(orgId, "organization id");
    assertPageReadLimit(page.limit);
    if (
      page.afterSequence !== undefined &&
      (!Number.isSafeInteger(page.afterSequence) || page.afterSequence < 1)
    ) {
      throw new Error("Registry audit cursor sequence is invalid");
    }
    const result = await this.#database.query(
      `SELECT sequence, event_id, request_id, org_id, actor_id, actor_kind,
              action, target_type, target_id, metadata, occurred_at
         FROM registry_audit_events
        WHERE org_id = $1
          AND ($2::bigint IS NULL OR sequence < $2::bigint)
        ORDER BY sequence DESC
        LIMIT $3`,
      [orgId, page.afterSequence ?? null, page.limit],
    );
    return result.rows.map(mapAuditEvent);
  }

  async #atomic<T>(
    work: (repository: PostgresRegistryRepository) => Promise<T>,
  ): Promise<T> {
    return this.#insideTransaction ? work(this) : this.transaction(work);
  }
}

const SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL = `
  selected_approval_counts AS (
    SELECT approval.release_id, count(*)::integer AS approval_count
      FROM registry_release_approvals AS approval
      JOIN selected_releases AS selected
        ON selected.id = approval.release_id
     WHERE approval.decision = 'approved'
     GROUP BY approval.release_id
  )`;

const SELECTED_RELEASE_COLUMNS_SQL = `
  SELECT r.id, p.org_id, r.package_id, p.name AS package_name, r.version,
         r.status, r.artifact_integrity, r.artifact, r.manifest, r.provenance,
         r.submitted_by, r.created_at, r.published_at, r.rejected_at,
         r.rejection_reason, r.yanked_at, r.yank_reason,
         COALESCE(approvals.approval_count, 0) AS approval_count`;

const SELECTED_RELEASE_FROM_SQL = `
    FROM selected_releases AS selected
    JOIN registry_releases AS r ON r.id = selected.id
    JOIN registry_packages AS p ON p.id = r.package_id
    LEFT JOIN selected_approval_counts AS approvals
      ON approvals.release_id = r.id`;

const GET_RELEASE_SQL = [
  `WITH selected_releases AS (
    SELECT r.id
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE p.org_id = $1 AND p.name = $2 AND r.version = $3
  ),`,
  SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL,
  SELECTED_RELEASE_COLUMNS_SQL,
  SELECTED_RELEASE_FROM_SQL,
].join("\n");

const LIST_RELEASES_SQL = [
  `WITH selected_releases AS (
    SELECT r.id, r.version
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE p.org_id = $1 AND p.name = $2
  ),`,
  SELECTED_RELEASE_APPROVAL_COUNTS_CTE_SQL,
  SELECTED_RELEASE_COLUMNS_SQL,
  SELECTED_RELEASE_FROM_SQL,
  "ORDER BY selected.version",
].join("\n");

async function rollbackOrThrow(
  client: RegistrySqlExecutor,
  originalError: unknown,
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Registry transaction and rollback both failed",
    );
  }
  throw originalError;
}

function isRegistrySqlPool(
  database: RegistrySqlExecutor,
): database is RegistrySqlPool {
  return "connect" in database && typeof database.connect === "function";
}

function requireSingleRow(
  result: RegistrySqlResult,
  description: string,
): Record<string, unknown> {
  if (result.rows.length !== 1 || !result.rows[0]) {
    throw new Error("Database did not return exactly one expected row");
  }
  return result.rows[0];
}

function mapUser(row: Record<string, unknown>): StoredRegistryUser {
  const status = asString(row.status, "user status");
  if (status !== "active" && status !== "suspended") {
    throw new Error("Unexpected registry user status");
  }
  return Object.freeze({
    id: asString(row.id, "user id"),
    issuer: asString(row.issuer, "issuer"),
    identity_issuer: asNullableString(row.identity_issuer, "identity issuer"),
    subject: asString(row.subject, "subject"),
    display_name: asString(row.display_name, "display name"),
    status,
    created_at: asTimestamp(row.created_at, "created_at"),
  });
}

function mapOrganization(
  row: Record<string, unknown>,
): StoredRegistryOrganization {
  const plan = asString(row.plan, "organization plan");
  if (plan !== "free" && plan !== "team" && plan !== "enterprise") {
    throw new Error("Unexpected registry organization plan");
  }
  return Object.freeze({
    id: asString(row.id, "organization id"),
    slug: asString(row.slug, "organization slug"),
    name: asString(row.name, "organization name"),
    owner_user_id: asString(row.owner_user_id, "organization owner"),
    plan,
    two_person_approval: asBoolean(
      row.two_person_approval,
      "two_person_approval",
    ),
    created_at: asTimestamp(row.created_at, "created_at"),
  });
}

function mapMembership(row: Record<string, unknown>): StoredRegistryMembership {
  const role = asString(row.role, "membership role");
  assertRegistryRole(role);
  return Object.freeze({
    org_id: asString(row.org_id, "organization id"),
    user_id: asString(row.user_id, "user id"),
    role,
    created_at: asTimestamp(row.created_at, "created_at"),
  });
}

function mapPackage(row: Record<string, unknown>): StoredRegistryPackage {
  const visibility = asString(row.visibility, "package visibility");
  if (visibility !== "public" && visibility !== "private") {
    throw new Error("Unexpected registry package visibility");
  }
  return Object.freeze({
    id: asString(row.id, "package id"),
    org_id: asString(row.org_id, "organization id"),
    name: asString(row.name, "package name"),
    visibility,
    description: asString(row.description, "package description", true),
    created_by: asString(row.created_by, "package creator"),
    created_at: asTimestamp(row.created_at, "created_at"),
  });
}

function mapPublicPackageSearchHit(
  row: Record<string, unknown>,
): StoredPublicRegistryPackageSearchHit {
  const registryPackage = mapPackage(row);
  const discoveryAvailable =
    row.discovery_available === undefined
      ? false
      : asBoolean(row.discovery_available, "discovery_available");
  const discovery = discoveryAvailable
    ? PublicPackDiscoveryDocumentSchema.parse({
        version: asSafeInteger(
          row.discovery_schema_version,
          "discovery schema version",
        ),
        description: asString(
          row.discovery_description,
          "discovery description",
          true,
        ),
        languages: asStringArray(
          row.discovery_languages,
          "discovery languages",
        ),
        ecosystems: asStringArray(
          row.discovery_ecosystems,
          "discovery ecosystems",
        ),
        tags: asStringArray(row.discovery_tags, "discovery tags"),
        lesson_count: asSafeInteger(
          row.discovery_lesson_count,
          "discovery lesson count",
        ),
      })
    : emptyPublicPackDiscoveryDocument();
  return Object.freeze({
    ...registryPackage,
    latest_version: asNullableString(row.latest_version, "latest version"),
    discovery_available: discoveryAvailable,
    discovery,
  });
}

function mapRelease(row: Record<string, unknown>): StoredRegistryRelease {
  const status = asString(row.status, "release status");
  if (
    status !== "pending" &&
    status !== "published" &&
    status !== "rejected" &&
    status !== "yanked"
  ) {
    throw new Error("Unexpected registry release status");
  }
  return Object.freeze({
    id: asString(row.id, "release id"),
    org_id: asString(row.org_id, "organization id"),
    package_id: asString(row.package_id, "package id"),
    package_name: asString(row.package_name, "package name"),
    version: asString(row.version, "release version"),
    status,
    artifact_integrity: asString(row.artifact_integrity, "artifact integrity"),
    artifact: asJsonObject(row.artifact, "artifact"),
    manifest: asJsonObject(row.manifest, "manifest"),
    provenance: asJsonObject(row.provenance, "provenance"),
    submitted_by: asString(row.submitted_by, "release submitter"),
    created_at: asTimestamp(row.created_at, "created_at"),
    published_at: asNullableTimestamp(row.published_at, "published_at"),
    rejected_at: asNullableTimestamp(row.rejected_at, "rejected_at"),
    rejection_reason: asNullableString(
      row.rejection_reason,
      "rejection_reason",
    ),
    yanked_at: asNullableTimestamp(row.yanked_at, "yanked_at"),
    yank_reason: asNullableString(row.yank_reason, "yank_reason"),
    approval_count: asSafeInteger(row.approval_count, "approval_count"),
  });
}

function mapApproval(
  row: Record<string, unknown>,
): StoredRegistryReleaseApproval {
  const decision = asString(row.decision, "approval decision");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("Unexpected registry approval decision");
  }
  return Object.freeze({
    id: asString(row.id, "approval id"),
    release_id: asString(row.release_id, "release id"),
    reviewer_user_id: asString(row.reviewer_user_id, "reviewer user id"),
    decision,
    created_at: asTimestamp(row.created_at, "created_at"),
  });
}

function mapAuditEvent(row: Record<string, unknown>): StoredRegistryAuditEvent {
  const actorKind = asString(row.actor_kind, "audit actor kind");
  if (
    actorKind !== "human" &&
    actorKind !== "service" &&
    actorKind !== "system"
  ) {
    throw new Error("Unexpected registry audit actor kind");
  }
  return Object.freeze({
    sequence: asSafeInteger(row.sequence, "audit sequence"),
    event_id: asString(row.event_id, "audit event id"),
    request_id: asString(row.request_id, "audit request id"),
    org_id: asString(row.org_id, "organization id"),
    actor_id: asNullableString(row.actor_id, "audit actor id"),
    actor_kind: actorKind,
    action: asString(row.action, "audit action"),
    target_type: asString(row.target_type, "audit target type"),
    target_id: asString(row.target_id, "audit target id"),
    metadata: asJsonObject(row.metadata, "audit metadata"),
    occurred_at: asTimestamp(row.occurred_at, "occurred_at"),
  });
}

function mapApiToken(row: Record<string, unknown>): StoredRegistryApiToken {
  const scopes = row.scopes;
  if (!Array.isArray(scopes)) {
    throw new Error("Unexpected Registry API token scopes");
  }
  const parsedScopes = scopes.map((scope) => {
    const value = asString(scope, "API token scope");
    if (!(REGISTRY_PERMISSIONS as readonly string[]).includes(value)) {
      throw new Error("Unexpected Registry API token scope");
    }
    return value as RegistryPermission;
  });
  const expiresAt = asNullableTimestamp(row.expires_at, "expires_at");
  const orgId = asNullableString(row.org_id, "organization id");
  if (!expiresAt || !orgId) {
    throw new Error("Registry API tokens require organization and expiry");
  }
  return Object.freeze({
    tokenId: asString(row.id, "API token id"),
    tenantId: orgId,
    subjectId: asString(row.user_id, "API token subject"),
    sha256: asString(row.token_hash, "API token hash"),
    prefix: asString(row.prefix, "API token prefix"),
    scopes: Object.freeze(parsedScopes),
    createdAt: asTimestamp(row.created_at, "created_at"),
    expiresAt,
    revokedAt: asNullableTimestamp(row.revoked_at, "revoked_at"),
  });
}

function validateApiTokenInput(input: InsertRegistryApiTokenInput): void {
  assertNonEmpty(input.tokenId, "API token id");
  assertNonEmpty(input.tenantId, "organization id");
  assertNonEmpty(input.subjectId, "API token subject");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error("API token hash must be SHA-256 hex");
  }
  assertNonEmpty(input.prefix, "API token prefix");
  if (
    input.scopes.length === 0 ||
    new Set(input.scopes).size !== input.scopes.length
  ) {
    throw new Error("API token scopes must be unique and non-empty");
  }
  for (const scope of input.scopes) {
    if (!(REGISTRY_PERMISSIONS as readonly string[]).includes(scope)) {
      throw new Error("API token scope is invalid");
    }
  }
  assertTimestamp(input.createdAt, "created_at");
  assertTimestamp(input.expiresAt, "expires_at");
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
    throw new Error("API token expiry must follow creation");
  }
  if (input.revokedAt !== null) assertTimestamp(input.revokedAt, "revoked_at");
}

function validateOrganizationInput(
  input: CreateRegistryOrganizationInput,
): void {
  assertNonEmpty(input.id, "organization id");
  assertNonEmpty(input.slug, "organization slug");
  assertNonEmpty(input.name, "organization name");
  assertNonEmpty(input.owner_user_id, "organization owner");
  const configuredApproval = (
    input as CreateRegistryOrganizationInput & {
      readonly two_person_approval?: unknown;
    }
  ).two_person_approval;
  if (configuredApproval !== undefined && configuredApproval !== true) {
    throw new Error("Registry organizations require two-person approval");
  }
  assertTimestamp(input.created_at, "created_at");
}

function validatePackageInput(input: CreateRegistryPackageInput): void {
  assertNonEmpty(input.id, "package id");
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.name, "package name");
  assertNonEmpty(input.created_by, "package creator");
  assertTimestamp(input.created_at, "created_at");
}

function validateReleaseInput(input: CreateRegistryReleaseInput): void {
  assertNonEmpty(input.id, "release id");
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.package_name, "package name");
  assertNonEmpty(input.version, "release version");
  assertNonEmpty(input.artifact_integrity, "artifact integrity");
  assertNonEmpty(input.submitted_by, "release submitter");
  assertTimestamp(input.created_at, "created_at");
  assertJsonObject(input.artifact, "artifact");
  assertJsonObject(input.manifest, "manifest");
  assertJsonObject(input.provenance, "provenance");
  PublicPackDiscoveryDocumentSchema.parse(input.discovery);
}

function validateApprovalInput(input: ApproveRegistryReleaseInput): void {
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.package_name, "package name");
  assertNonEmpty(input.version, "release version");
  assertNonEmpty(input.reviewer_user_id, "reviewer user id");
  assertNonEmpty(input.request_id, "request id");
  assertTimestamp(input.approved_at, "approved_at");
}

function validateRejectionInput(input: RejectRegistryReleaseInput): void {
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.package_name, "package name");
  assertNonEmpty(input.version, "release version");
  assertNonEmpty(input.reviewer_user_id, "reviewer user id");
  assertNonEmpty(input.reason, "rejection reason");
  assertNonEmpty(input.request_id, "request id");
  assertTimestamp(input.rejected_at, "rejected_at");
}

function validateYankInput(input: YankRegistryReleaseInput): void {
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.package_name, "package name");
  assertNonEmpty(input.version, "release version");
  assertNonEmpty(input.reviewer_user_id, "reviewer user id");
  assertNonEmpty(input.reason, "yank reason");
  assertNonEmpty(input.request_id, "request id");
  assertTimestamp(input.yanked_at, "yanked_at");
}

function validateAuditInput(input: AppendRegistryAuditEventInput): void {
  assertNonEmpty(input.event_id, "audit event id");
  assertNonEmpty(input.request_id, "audit request id");
  assertNonEmpty(input.org_id, "organization id");
  assertNonEmpty(input.action, "audit action");
  assertNonEmpty(input.target_type, "audit target type");
  assertNonEmpty(input.target_id, "audit target id");
  assertTimestamp(input.occurred_at, "occurred_at");
  assertJsonObject(input.metadata, "audit metadata");
  if (input.actor_kind === "system" && input.actor_id !== null) {
    throw new Error("System audit actors must not have actor_id");
  }
  if (input.actor_kind !== "system" && input.actor_id === null) {
    throw new Error("Human and service audit actors require actor_id");
  }
}

function throwConflictIfUnique(error: unknown, message: string): never {
  if (isUniqueViolation(error)) {
    throw new RegistryStorageConflictError(message, { cause: error });
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "23505") return true;
  const message = "message" in error ? error.message : undefined;
  return (
    typeof message === "string" &&
    /duplicate key|unique constraint|already exists/i.test(message)
  );
}

function assertRegistryRole(value: string): asserts value is RegistryRole {
  if (!(REGISTRY_ROLES as readonly string[]).includes(value)) {
    throw new Error("Unknown registry role");
  }
}

function assertPageReadLimit(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PUBLIC_PAGE_READ_LIMIT
  ) {
    throw new Error("Public Registry page read limit is invalid");
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Registry value must not be empty");
  }
}

function assertOptionalIdentityIssuer(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  assertNonEmpty(value, "identity issuer");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("identity issuer must be a credential-free HTTPS URL");
  }
  if (
    value.length > 2_048 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== value
  ) {
    throw new Error("identity issuer must be a credential-free HTTPS URL");
  }
}

function assertTimestamp(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("Registry timestamp must be canonical ISO format");
  }
}

function assertJsonObject(
  value: unknown,
  label: string,
): asserts value is RegistryJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registry JSON value must be an object");
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error("Registry JSON object must be serializable", {
      cause: error,
    });
  }
}

function asString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error("Database string value is invalid");
  }
  return value;
}

function asNullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : asString(value, label);
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Database string-array value is invalid");
  }
  return value.map((item) => asString(item, label));
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Database boolean value is invalid");
  }
  return value;
}

function asTimestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(asString(value, label));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Database timestamp value is invalid");
  }
  return date.toISOString();
}

function asNullableTimestamp(value: unknown, label: string): string | null {
  return value === null || value === undefined
    ? null
    : asTimestamp(value, label);
}

function asSafeInteger(value: unknown, label: string): number {
  const integer =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(integer) || integer < 0) {
    throw new Error("Database integer value is invalid");
  }
  return integer;
}

function asJsonObject(value: unknown, label: string): RegistryJsonObject {
  assertJsonObject(value, label);
  return JSON.parse(JSON.stringify(value)) as RegistryJsonObject;
}
