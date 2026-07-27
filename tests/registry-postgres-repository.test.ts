import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataType, newDb } from "pg-mem";
import { enablePgMemRlsCompat } from "./helpers/pg-mem-rls.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRegistryMigrations,
  PostgresRegistryRepository,
  RegistryStorageConflictError,
  RegistryStorageForbiddenError,
  RegistryStorageTransitionError,
  type RegistrySqlExecutor,
  type RegistrySqlPool,
} from "../src/registry-postgres.js";
import { emptyPublicPackDiscoveryDocument } from "../src/registry-search.js";

const T0 = "2026-07-16T12:00:00.000Z";
const T1 = "2026-07-16T12:01:00.000Z";
const T2 = "2026-07-16T12:02:00.000Z";

interface Harness {
  readonly pool: RegistrySqlPool & { end(): Promise<void> };
  readonly repository: PostgresRegistryRepository;
}

const pools: Array<RegistrySqlPool & { end(): Promise<void> }> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createMemoryDatabase() {
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
  return database;
}

async function createHarness(): Promise<Harness> {
  const database = createMemoryDatabase();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as RegistrySqlPool & {
    end(): Promise<void>;
  };
  pools.push(pool);
  const migration = await applyRegistryMigrations(pool);
  expect(migration).toEqual({
    applied: [
      "001_registry.sql",
      "002_registry_runtime.sql",
      "003_registry_telemetry.sql",
      "004_registry_identity_issuer.sql",
      "005_registry_row_level_security.sql",
      "006_registry_public_release_rls.sql",
      "007_registry_append_only_integrity.sql",
      "008_registry_semver_keyset.sql",
      "009_registry_public_discovery.sql",
    ],
    skipped: [],
  });
  return {
    pool,
    repository: new PostgresRegistryRepository(pool, {
      idFactory: (() => {
        let next = 0;
        return () => `generated-${++next}`;
      })(),
    }),
  };
}

describe("applyRegistryMigrations", () => {
  it("holds one fixed advisory lock across table creation and the migration loop", async () => {
    const events: string[] = [];
    const values: Array<unknown[] | undefined> = [];
    const connection = {
      async query(sql: string, parameters?: unknown[]) {
        events.push(sql.trim());
        values.push(parameters);
        if (sql.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      },
      release() {
        events.push("RELEASE_CONNECTION");
        values.push(undefined);
      },
    };
    const pool: RegistrySqlPool = {
      query: connection.query,
      async connect() {
        return connection;
      },
    };

    await expect(applyRegistryMigrations(pool)).resolves.toEqual({
      applied: [
        "001_registry.sql",
        "002_registry_runtime.sql",
        "003_registry_telemetry.sql",
        "004_registry_identity_issuer.sql",
        "005_registry_row_level_security.sql",
        "006_registry_public_release_rls.sql",
        "007_registry_append_only_integrity.sql",
        "008_registry_semver_keyset.sql",
        "009_registry_public_discovery.sql",
      ],
      skipped: [],
    });

    expect(events[0]).toBe("SELECT pg_advisory_lock($1::integer, $2::integer)");
    expect(values[0]).toEqual([0x5069744c, 0x6f72654d]);
    const tableCreation = events.findIndex((sql) =>
      sql.includes("CREATE TABLE registry_schema_migrations"),
    );
    const lastCommit = events.lastIndexOf("COMMIT");
    const unlock = events.findIndex((sql) =>
      sql.includes("pg_advisory_unlock"),
    );
    expect(tableCreation).toBeGreaterThan(0);
    expect(lastCommit).toBeGreaterThan(tableCreation);
    expect(unlock).toBeGreaterThan(lastCommit);
    expect(events.at(-2)).toBe(
      "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
    );
    expect(values.at(-2)).toEqual(values[0]);
    expect(events.at(-1)).toBe("RELEASE_CONNECTION");
  });

  it("rolls back, unlocks, and releases the connection when a migration fails", async () => {
    const events: string[] = [];
    const connection = {
      async query(sql: string) {
        events.push(sql.trim());
        if (sql.includes("CREATE TABLE IF NOT EXISTS registry_users")) {
          throw new Error("injected migration failure");
        }
        if (sql.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      },
      release() {
        events.push("RELEASE_CONNECTION");
      },
    };
    const pool: RegistrySqlPool = {
      query: connection.query,
      async connect() {
        return connection;
      },
    };

    await expect(applyRegistryMigrations(pool)).rejects.toThrow(
      "injected migration failure",
    );

    const rollback = events.indexOf("ROLLBACK");
    const unlock = events.findIndex((sql) =>
      sql.includes("pg_advisory_unlock"),
    );
    expect(rollback).toBeGreaterThan(events.indexOf("BEGIN"));
    expect(unlock).toBeGreaterThan(rollback);
    expect(events.at(-1)).toBe("RELEASE_CONNECTION");
  });

  it("rejects removed history and migrations inserted before the applied tail", async () => {
    const missingDirectory = migrationDirectory({
      "001_first.sql": "CREATE TABLE first_table (id text PRIMARY KEY);\n",
      "002_second.sql": "CREATE TABLE second_table (id text PRIMARY KEY);\n",
    });
    const missingPool = memoryPool();
    await applyRegistryMigrations(missingPool, { directory: missingDirectory });
    fs.rmSync(path.join(missingDirectory, "001_first.sql"));
    await expect(
      applyRegistryMigrations(missingPool, { directory: missingDirectory }),
    ).rejects.toThrow("migration file is missing");

    const orderDirectory = migrationDirectory({
      "002_second.sql": "CREATE TABLE second_table (id text PRIMARY KEY);\n",
    });
    const orderPool = memoryPool();
    await applyRegistryMigrations(orderPool, { directory: orderDirectory });
    fs.writeFileSync(
      path.join(orderDirectory, "001_inserted_late.sql"),
      "CREATE TABLE inserted_late (id text PRIMARY KEY);\n",
      "utf8",
    );
    await expect(
      applyRegistryMigrations(orderPool, { directory: orderDirectory }),
    ).rejects.toThrow("must be appended");
  });

  it("rejects duplicate numeric migration versions before opening a connection", async () => {
    const directory = migrationDirectory({
      "001_first.sql": "CREATE TABLE first_table (id text PRIMARY KEY);\n",
      "001_duplicate.sql":
        "CREATE TABLE duplicate_table (id text PRIMARY KEY);\n",
    });
    let connected = false;
    const pool: RegistrySqlPool = {
      async query() {
        return { rows: [], rowCount: null };
      },
      async connect() {
        connected = true;
        throw new Error("must not connect");
      },
    };

    await expect(applyRegistryMigrations(pool, { directory })).rejects.toThrow(
      "version prefixes must be unique",
    );
    expect(connected).toBe(false);
  });

  it("reconciles least-privilege runtime DML after every migration run", async () => {
    const events: string[] = [];
    const connection = {
      async query(sql: string) {
        events.push(sql.trim());
        if (sql.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      },
      release() {
        events.push("RELEASE_CONNECTION");
      },
    };
    const pool: RegistrySqlPool = {
      query: connection.query,
      async connect() {
        return connection;
      },
    };

    await applyRegistryMigrations(pool, { runtimeRole: "pitlore_runtime" });

    const reconciliation = events.findIndex(
      (sql) =>
        sql.includes("REVOKE ALL PRIVILEGES ON ALL TABLES") &&
        sql.includes("GRANT SELECT ON TABLE registry_schema_migrations"),
    );
    const unlock = events.findIndex((sql) =>
      sql.includes("pg_advisory_unlock"),
    );
    expect(reconciliation).toBeGreaterThan(
      events.lastIndexOf("COMMIT", reconciliation - 1),
    );
    expect(unlock).toBeGreaterThan(reconciliation);
    const reconciliationSql = events[reconciliation] ?? "";
    expect(reconciliationSql).toContain(
      "REVOKE ALL PRIVILEGES ON ALL SEQUENCES",
    );
    expect(reconciliationSql).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES",
    );
    expect(reconciliationSql).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES",
    );
    expect(
      reconciliationSql
        .split(";\n")
        .some((sql) => sql.startsWith("GRANT ") && sql.includes(" ON ALL ")),
    ).toBe(false);

    for (const expected of [
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
    ]) {
      expect(reconciliationSql).toContain(expected);
    }

    await expect(
      applyRegistryMigrations(pool, { runtimeRole: "pitlore_runtime;drop" }),
    ).rejects.toThrow("only supports pitlore_runtime");
  });

  it("ships database guards for immutable release payloads and append-only evidence", () => {
    const source = fs.readFileSync(
      path.resolve("migrations/007_registry_append_only_integrity.sql"),
      "utf8",
    );

    for (const column of [
      "id",
      "package_id",
      "version",
      "artifact_integrity",
      "artifact",
      "manifest",
      "provenance",
      "submitted_by",
      "created_at",
    ]) {
      expect(source).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(source).toContain(
      "BEFORE UPDATE OR DELETE ON registry_release_approvals",
    );
    expect(source).toContain("BEFORE INSERT ON registry_release_approvals");
    expect(source).toContain(
      "BEFORE UPDATE OR DELETE ON registry_audit_events",
    );
    for (const table of [
      "registry_releases",
      "registry_release_approvals",
      "registry_audit_events",
      "registry_usage_events",
      "registry_usage_reservations",
      "registry_billing_webhook_events",
    ]) {
      expect(source).toContain(`BEFORE TRUNCATE ON ${table}`);
    }
    expect(source).toContain(
      "OLD.status = 'pending' AND NEW.status = 'published'",
    );
    expect(source).toContain(
      "OLD.status = 'pending' AND NEW.status = 'rejected'",
    );
    expect(source).toContain(
      "OLD.status = 'published' AND NEW.status = 'yanked'",
    );
    expect(source).toContain("count(DISTINCT reviewer_user_id)::integer");
    expect(source).toContain("approved_reviewer_count <> 2");
    expect(source).toContain("FOR UPDATE OF r");
    expect(source).toContain("existing_approved_count >= 2");
    expect(source).toContain(
      "registry release accepts exactly two approved decisions",
    );
    expect(source).toContain(
      "registry release rejection requires a rejected decision",
    );
    expect(source).toContain(
      "registry release reviewer must be an active admin or owner",
    );
    expect(source).toContain(
      "ADD CONSTRAINT registry_organizations_two_person_approval_required",
    );
    expect(source).toContain("CHECK (two_person_approval IS TRUE)");
  });

  it("ships an immutable C-collated generated SemVer keyset index", () => {
    const source = fs.readFileSync(
      path.resolve("migrations/008_registry_semver_keyset.sql"),
      "utf8",
    );
    expect(source).toMatch(
      /CREATE FUNCTION registry_semver_sort_key[\s\S]*IMMUTABLE[\s\S]*STRICT[\s\S]*PARALLEL SAFE/,
    );
    expect(source).toContain("9007199254740991");
    expect(source).toContain("numeric prerelease has a leading zero");
    expect(source).toContain('semver_sort_key text[] COLLATE "C"');
    expect(source).toContain('semver_version_tie_key text COLLATE "C"');
    expect(source).toContain("GENERATED ALWAYS AS");
    expect(source).toMatch(
      /CREATE INDEX registry_releases_package_semver_keyset_idx[\s\S]*package_id, semver_sort_key DESC, semver_version_tie_key DESC/,
    );
  });

  it("ships an append-only and privacy-safe public discovery projection", () => {
    const source = fs.readFileSync(
      path.resolve("migrations/009_registry_public_discovery.sql"),
      "utf8",
    );
    expect(source).toContain("CREATE TABLE registry_release_discovery");
    expect(source).toContain("CREATE TABLE registry_release_discovery_facets");
    expect(source).toContain("UNIQUE (package_id, id)");
    expect(source).toContain("FOREIGN KEY (package_id, release_id)");
    expect(source).toContain(
      "registry_release_discovery_facets_release_fk",
    );
    expect(source).toContain("FOREIGN KEY (id, discovery_release_id)");
    expect(source).toContain("release.status IN ('published', 'yanked')");
    expect(source).toContain("package.visibility = 'public'");
    expect(source).toContain(
      "BEFORE UPDATE OR DELETE ON registry_release_discovery",
    );
    expect(source).toContain("BEFORE TRUNCATE ON registry_release_discovery");
    expect(source).toContain(
      "BEFORE UPDATE OR DELETE ON registry_release_discovery_facets",
    );
    expect(source).toContain(
      "BEFORE TRUNCATE ON registry_release_discovery_facets",
    );
    expect(source).toMatch(
      /WHERE status = 'published'[\s\S]*ORDER BY semver_sort_key DESC, semver_version_tie_key DESC/,
    );
    expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(source).toContain(
      "CREATE INDEX registry_release_discovery_facets_lookup_idx",
    );
    expect(source).toContain(
      "(dimension, value, release_id, package_id)",
    );
    expect(source).toContain("registry_validate_discovery_facet");
    expect(source).toContain("registry_release_discovery_require_facets");
    expect(source).not.toContain("USING GIN");
  });
});

function memoryPool(): RegistrySqlPool & { end(): Promise<void> } {
  const database = createMemoryDatabase();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
  pools.push(pool);
  return pool;
}

function migrationDirectory(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-migrations-"));
  tempRoots.push(root);
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), source, "utf8");
  }
  return root;
}

async function seedUsers(
  repository: PostgresRegistryRepository,
): Promise<void> {
  for (const id of [
    "owner-a",
    "admin-a",
    "admin-b",
    "publisher-a",
    "viewer-a",
    "owner-b",
  ]) {
    await repository.insertUser({
      id,
      issuer: "test",
      subject: `subject-${id}`,
      display_name: id,
      created_at: T0,
    });
  }
}

async function seedOrganizations(
  repository: PostgresRegistryRepository,
): Promise<void> {
  await seedUsers(repository);
  await repository.createOrganization({
    id: "org-a",
    slug: "org-a",
    name: "Org A",
    owner_user_id: "owner-a",
    created_at: T0,
  });
  await repository.createOrganization({
    id: "org-b",
    slug: "org-b",
    name: "Org B",
    owner_user_id: "owner-b",
    created_at: T0,
  });
  await repository.addMember({
    org_id: "org-a",
    user_id: "admin-a",
    role: "admin",
    created_at: T0,
  });
  await repository.addMember({
    org_id: "org-a",
    user_id: "admin-b",
    role: "admin",
    created_at: T0,
  });
  await repository.addMember({
    org_id: "org-a",
    user_id: "publisher-a",
    role: "publisher",
    created_at: T0,
  });
  await repository.addMember({
    org_id: "org-a",
    user_id: "viewer-a",
    role: "viewer",
    created_at: T0,
  });
}

describe("PostgresRegistryRepository", () => {
  it("pushes authenticated collection bounds and keysets into SQL", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const database: RegistrySqlExecutor = {
      async query(sql, values) {
        calls.push({ sql, ...(values === undefined ? {} : { values }) });
        return { rows: [], rowCount: 0 };
      },
    };
    const repository = new PostgresRegistryRepository(database);

    await repository.listMemberPage("org-a", { after: "user-a", limit: 2 });
    await repository.listApiTokenPage("org-a", {
      afterCreatedAt: T1,
      afterId: "token-a",
      limit: 3,
    });
    await repository.listPackagePage("org-a", {
      after: "org-a/alpha",
      limit: 4,
    });
    await repository.listReleasePage("org-a", {
      packageName: "org-a/core",
      after: { packageName: "org-a/core", version: "2.0.0" },
      limit: 5,
    });
    await repository.listAuditEventPage("org-a", {
      afterSequence: 42,
      limit: 6,
    });

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.sql).toMatch(/WHERE[\s\S]+org_id = \$1/);
      expect(call.sql).toMatch(/LIMIT \$\d+/);
      expect(call.values?.[0]).toBe("org-a");
    }
    expect(calls[0]?.sql).toContain("user_id > $2");
    expect(calls[0]?.values?.at(-1)).toBe(2);
    expect(calls[1]?.sql).toContain("created_at > $2::timestamptz");
    expect(calls[1]?.sql).toContain("id > $3");
    expect(calls[2]?.sql).toContain("name > $2");
    expect(calls[3]?.sql).toContain(
      "r.semver_sort_key < registry_semver_sort_key($4)",
    );
    expect(calls[3]?.sql).toContain("r.semver_version_tie_key < $4");
    expect(calls[3]?.sql).toContain("LIMIT $5");
    expect(calls[3]?.values?.at(-1)).toBe(5);
    expect(calls[4]?.sql).toContain("sequence < $2::bigint");
    expect(calls[4]?.sql).toContain("ORDER BY sequence DESC");
  });

  it("does not expose a switch that weakens two-person approval", async () => {
    const { repository } = await createHarness();
    await seedUsers(repository);

    await expect(
      repository.createOrganization({
        id: "org-unsafe",
        slug: "org-unsafe",
        name: "Unsafe",
        owner_user_id: "owner-a",
        // @ts-expect-error false is intentionally excluded from the API.
        two_person_approval: false,
        created_at: T0,
      }),
    ).rejects.toThrow("require two-person approval");
    await expect(repository.getOrganization("org-unsafe")).resolves.toBeNull();
  });

  it("applies the migration idempotently and rolls failed transactions back", async () => {
    const { pool } = await createHarness();
    await expect(applyRegistryMigrations(pool)).resolves.toEqual({
      applied: [],
      skipped: [
        "001_registry.sql",
        "002_registry_runtime.sql",
        "003_registry_telemetry.sql",
        "004_registry_identity_issuer.sql",
        "005_registry_row_level_security.sql",
        "006_registry_public_release_rls.sql",
        "007_registry_append_only_integrity.sql",
        "008_registry_semver_keyset.sql",
        "009_registry_public_discovery.sql",
      ],
    });

    const commands: string[] = [];
    let released = false;
    const connection = {
      async query(sql: string) {
        commands.push(sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "");
        if (sql.includes("INSERT INTO registry_users")) {
          return {
            rows: [
              {
                id: "rolled-back",
                issuer: "test",
                subject: "rolled-back",
                display_name: "Rolled Back",
                status: "active",
                created_at: T0,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: null };
      },
      release() {
        released = true;
      },
    };
    const transactionRepository = new PostgresRegistryRepository({
      query: connection.query,
      async connect() {
        return connection;
      },
    });
    await expect(
      transactionRepository.transaction(async (transaction) => {
        await transaction.insertUser({
          id: "rolled-back",
          issuer: "test",
          subject: "rolled-back",
          display_name: "Rolled Back",
          created_at: T0,
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(commands).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
    expect(released).toBe(true);
  });

  it("keeps organizations, memberships, packages, and reads tenant-scoped", async () => {
    const { repository } = await createHarness();
    await seedOrganizations(repository);

    const packageA = await repository.createPackage({
      id: "package-a",
      org_id: "org-a",
      name: "org-a/core",
      visibility: "private",
      created_by: "publisher-a",
      created_at: T0,
    });
    const packageB = await repository.createPackage({
      id: "package-b",
      org_id: "org-b",
      name: "org-b/core",
      visibility: "private",
      created_by: "owner-b",
      created_at: T0,
    });

    expect(packageA.org_id).toBe("org-a");
    expect(packageB.org_id).toBe("org-b");
    await expect(
      repository.getPackage("org-a", "org-a/core"),
    ).resolves.toMatchObject({
      id: "package-a",
      org_id: "org-a",
    });
    await expect(
      repository.getPackage("org-b", "org-b/core"),
    ).resolves.toMatchObject({
      id: "package-b",
      org_id: "org-b",
    });
    await expect(
      repository.getPackage("org-a", "org-b/only"),
    ).resolves.toBeNull();

    await expect(
      repository.createPackage({
        id: "viewer-package",
        org_id: "org-a",
        name: "org-a/viewer",
        visibility: "private",
        created_by: "viewer-a",
        created_at: T0,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageForbiddenError);
    expect(await repository.listMembers("org-b")).toEqual([
      expect.objectContaining({ user_id: "owner-b", role: "owner" }),
    ]);
  });

  it("reserves immutable package versions and publishes only after two human reviewers", async () => {
    const { pool, repository } = await createHarness();
    await seedOrganizations(repository);
    await repository.createPackage({
      id: "package-a",
      org_id: "org-a",
      name: "org-a/core",
      visibility: "private",
      created_by: "publisher-a",
      created_at: T0,
    });
    const release = await repository.createRelease({
      id: "release-a",
      org_id: "org-a",
      package_name: "org-a/core",
      version: "1.0.0",
      artifact_integrity: "sha256-original",
      artifact: { object_key: "immutable/object" },
      manifest: { name: "org-a/core", version: "1.0.0" },
      provenance: { commit: "a".repeat(40) },
      discovery: {
        version: 1,
        description: "Repository discovery facets",
        languages: ["typescript"],
        ecosystems: ["node"],
        tags: ["reliability", "security"],
        lesson_count: 2,
      },
      submitted_by: "publisher-a",
      created_at: T0,
    });
    expect(release).toMatchObject({ status: "pending", approval_count: 0 });
    const facets = await pool.query(
      `SELECT dimension, value
         FROM registry_release_discovery_facets
        WHERE release_id = $1
        ORDER BY dimension, value`,
      ["release-a"],
    );
    expect(facets.rows).toEqual([
      { dimension: "ecosystem", value: "node" },
      { dimension: "language", value: "typescript" },
      { dimension: "tag", value: "reliability" },
      { dimension: "tag", value: "security" },
    ]);

    await expect(
      repository.createRelease({
        id: "release-duplicate",
        org_id: "org-a",
        package_name: "org-a/core",
        version: "1.0.0",
        artifact_integrity: "sha256-replacement",
        artifact: { object_key: "replacement" },
        manifest: {},
        provenance: {},
        discovery: emptyPublicPackDiscoveryDocument(),
        submitted_by: "publisher-a",
        created_at: T1,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageConflictError);
    await expect(
      repository.approveRelease({
        org_id: "org-a",
        package_name: "org-a/core",
        version: "1.0.0",
        reviewer_user_id: "publisher-a",
        request_id: "request-self",
        approved_at: T1,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageForbiddenError);
    await expect(
      repository.approveRelease({
        org_id: "org-a",
        package_name: "org-a/core",
        version: "1.0.0",
        reviewer_user_id: "viewer-a",
        request_id: "request-viewer",
        approved_at: T1,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageForbiddenError);

    const first = await repository.approveRelease({
      org_id: "org-a",
      package_name: "org-a/core",
      version: "1.0.0",
      reviewer_user_id: "admin-a",
      request_id: "request-first",
      approved_at: T1,
    });
    expect(first).toMatchObject({ status: "pending", approval_count: 1 });
    const second = await repository.approveRelease({
      org_id: "org-a",
      package_name: "org-a/core",
      version: "1.0.0",
      reviewer_user_id: "admin-b",
      request_id: "request-second",
      approved_at: T2,
    });
    expect(second).toMatchObject({
      status: "published",
      approval_count: 2,
      artifact_integrity: "sha256-original",
      artifact: { object_key: "immutable/object" },
      published_at: T2,
    });
    await expect(
      repository.approveRelease({
        org_id: "org-a",
        package_name: "org-a/core",
        version: "1.0.0",
        reviewer_user_id: "owner-a",
        request_id: "request-third",
        approved_at: T2,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageTransitionError);

    expect(
      await repository.listReleaseApprovals("org-a", "org-a/core", "1.0.0"),
    ).toHaveLength(2);
    expect(
      (await repository.listAuditEvents("org-a")).map((event) => event.action),
    ).toEqual(["release.approved", "release.approved", "release.published"]);
    await expect(
      repository.getRelease("org-b", "org-a/core", "1.0.0"),
    ).resolves.toBeNull();
  });

  it("exposes append-only tenant-scoped audit reads", async () => {
    const { repository } = await createHarness();
    await seedOrganizations(repository);
    await repository.appendAuditEvent({
      event_id: "event-a",
      request_id: "request-a",
      org_id: "org-a",
      actor_id: "owner-a",
      actor_kind: "human",
      action: "organization.updated",
      target_type: "organization",
      target_id: "org-a",
      metadata: { field: "name" },
      occurred_at: T1,
    });
    await repository.appendAuditEvent({
      event_id: "event-b",
      request_id: "request-b",
      org_id: "org-b",
      actor_id: "owner-b",
      actor_kind: "human",
      action: "organization.updated",
      target_type: "organization",
      target_id: "org-b",
      metadata: { field: "name" },
      occurred_at: T2,
    });

    const auditA = await repository.listAuditEvents("org-a");
    expect(auditA).toEqual([
      expect.objectContaining({ event_id: "event-a", org_id: "org-a" }),
    ]);
    expect(Object.isFrozen(auditA[0])).toBe(true);
    await expect(
      repository.appendAuditEvent({
        event_id: "event-a",
        request_id: "request-replay",
        org_id: "org-a",
        actor_id: "owner-a",
        actor_kind: "human",
        action: "organization.updated",
        target_type: "organization",
        target_id: "org-a",
        metadata: {},
        occurred_at: T2,
      }),
    ).rejects.toBeInstanceOf(RegistryStorageConflictError);
    expect(await repository.listAuditEvents("org-b")).toEqual([
      expect.objectContaining({ event_id: "event-b", org_id: "org-b" }),
    ]);
  });
});
