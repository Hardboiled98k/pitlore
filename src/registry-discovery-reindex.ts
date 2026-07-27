import { RegistryPackArtifactSchema, withMaterializedRegistryPackArtifact } from "./registry-artifact.js";
import {
  appendRegistryReleaseDiscoveryFacets,
  type RegistrySqlConnection,
  type RegistrySqlPool,
} from "./registry-postgres.js";
import {
  PublicPackDiscoveryDocumentSchema,
  buildPublicPackDiscoveryDocument,
  type PublicPackDiscoveryDocument,
} from "./registry-search.js";

const DEFAULT_MAX_RELEASES = 1_000;
const MAX_REINDEX_RELEASES = 100_000;
const REINDEX_BATCH_SIZE = 128;

export interface RegistryDiscoveryReindexProgress {
  readonly package_name: string;
  readonly version: string;
  /** Discovery rows appended by this invocation, excluding concurrent wins. */
  readonly indexed: number;
}

export interface RegistryDiscoveryReindexOptions {
  /** Maximum releases this invocation may lock and fully verify. */
  readonly maxReleases?: number;
  readonly clock?: () => Date;
  readonly onProgress?: (progress: RegistryDiscoveryReindexProgress) => void;
}

export interface RegistryDiscoveryReindexResult {
  /** Discovery rows appended by this invocation, excluding concurrent wins. */
  readonly indexed: number;
  /** Whether no missing row was visible at the final database observation. */
  readonly complete: boolean;
}

/**
 * Rebuild missing release discovery rows from immutable artifacts.
 *
 * This operator path requires the migration-owner (or superuser) connection so
 * it can enumerate every tenant without weakening runtime RLS. Each artifact is
 * fully materialized and verified before one append-only row is inserted.
 */
export async function reindexRegistryReleaseDiscovery(
  pool: RegistrySqlPool,
  options: RegistryDiscoveryReindexOptions = {},
): Promise<RegistryDiscoveryReindexResult> {
  const maxReleases = boundedMaxReleases(
    options.maxReleases ?? DEFAULT_MAX_RELEASES,
  );
  const clock = options.clock ?? (() => new Date());
  await assertPrivilegedReindexConnection(pool);

  let indexed = 0;
  let processed = 0;
  let afterReleaseId: string | undefined;
  while (processed < maxReleases) {
    const missing = await selectMissingReleaseBatch(
      pool,
      afterReleaseId,
      Math.min(REINDEX_BATCH_SIZE, maxReleases - processed),
    );
    if (missing.rows.length === 0) {
      if (afterReleaseId === undefined) {
        return { indexed, complete: true };
      }
      // Release ids are caller-supplied text, so a concurrently inserted id can
      // sort before the current cursor. Wrap only after exhausting this ordered
      // pass; the next bounded query catches any such new missing release.
      afterReleaseId = undefined;
      continue;
    }

    for (const row of missing.rows) {
      const releaseId = requireString(row.release_id, "release id");
      const packageId = requireString(row.package_id, "package id");
      const packageName = requireString(row.package_name, "package name");
      const version = requireString(row.version, "release version");
      const inserted = await reindexMissingRelease(
        pool,
        releaseId,
        packageId,
        packageName,
        version,
        clock,
      );
      processed += 1;
      // Advance only after the release transaction commits. A verification or
      // insert failure aborts this run without skipping later candidates.
      afterReleaseId = releaseId;
      if (inserted) {
        indexed += 1;
        options.onProgress?.({ package_name: packageName, version, indexed });
      }
    }
  }

  const remaining = await pool.query(
    `SELECT 1
       FROM registry_releases AS r
       LEFT JOIN registry_release_discovery AS d ON d.release_id = r.id
      WHERE d.release_id IS NULL
      LIMIT 1`,
  );
  return { indexed, complete: remaining.rows.length === 0 };
}

async function selectMissingReleaseBatch(
  pool: RegistrySqlPool,
  afterReleaseId: string | undefined,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
  if (afterReleaseId === undefined) {
    return pool.query(
      `SELECT r.id AS release_id, r.package_id, p.name AS package_name,
              r.version
         FROM registry_releases AS r
         JOIN registry_packages AS p ON p.id = r.package_id
         LEFT JOIN registry_release_discovery AS d ON d.release_id = r.id
        WHERE d.release_id IS NULL
        ORDER BY r.id
        LIMIT $1`,
      [limit],
    );
  }
  return pool.query(
    `SELECT r.id AS release_id, r.package_id, p.name AS package_name,
            r.version
       FROM registry_releases AS r
       JOIN registry_packages AS p ON p.id = r.package_id
       LEFT JOIN registry_release_discovery AS d ON d.release_id = r.id
      WHERE d.release_id IS NULL
        AND r.id > $1
      ORDER BY r.id
      LIMIT $2`,
    [afterReleaseId, limit],
  );
}

async function assertPrivilegedReindexConnection(
  pool: RegistrySqlPool,
): Promise<void> {
  const result = await pool.query(
    `SELECT role.rolsuper
              OR pg_get_userbyid(table_class.relowner) = current_user
              AS allowed
       FROM pg_class AS table_class
       JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
       JOIN pg_roles AS role ON role.rolname = current_user
      WHERE namespace.nspname = 'public'
        AND table_class.relname = 'registry_release_discovery'
        AND table_class.relkind IN ('r', 'p')`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.allowed !== true) {
    throw new Error(
      "Registry discovery reindex requires the migration-owner database connection",
    );
  }
}

async function reindexMissingRelease(
  pool: RegistrySqlPool,
  releaseId: string,
  packageId: string,
  packageName: string,
  version: string,
  clock: () => Date,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    try {
      const locked = await connection.query(
        `SELECT r.id, r.package_id, p.name AS package_name, r.version,
                r.artifact
           FROM registry_releases AS r
           JOIN registry_packages AS p ON p.id = r.package_id
          WHERE r.id = $1
          FOR UPDATE`,
        [releaseId],
      );
      const current = locked.rows[0];
      if (
        !current ||
        current.package_id !== packageId ||
        current.package_name !== packageName ||
        current.version !== version
      ) {
        throw new Error("Registry release identity changed during discovery reindex");
      }
      const artifact = RegistryPackArtifactSchema.parse(current.artifact);
      if (artifact.name !== packageName || artifact.version !== version) {
        throw new Error(
          `Registry discovery reindex found an artifact identity mismatch for ${packageName}@${version}`,
        );
      }

      let discovery: PublicPackDiscoveryDocument;
      try {
        discovery = withMaterializedRegistryPackArtifact(
          artifact,
          buildPublicPackDiscoveryDocument,
        );
      } catch (error) {
        throw new Error(
          `Registry discovery reindex could not verify ${packageName}@${version}`,
          { cause: error },
        );
      }
      const existing = await connection.query(
        `SELECT schema_version, description, languages, ecosystems, tags,
                lesson_count
           FROM registry_release_discovery
          WHERE release_id = $1`,
        [releaseId],
      );
      if (existing.rows[0]) {
        const stored = parseStoredDiscovery(existing.rows[0]);
        if (JSON.stringify(stored) !== JSON.stringify(discovery)) {
          throw new Error(
            `Registry discovery reindex found conflicting metadata for ${packageName}@${version}`,
          );
        }
      } else {
        const indexedAt = canonicalTimestamp(clock());
        await connection.query(
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
            indexedAt,
          ],
        );
        await appendRegistryReleaseDiscoveryFacets(
          connection,
          releaseId,
          packageId,
          discovery,
        );
      }
      await connection.query("COMMIT");
      return existing.rows[0] === undefined;
    } catch (error) {
      return await rollbackReindex(connection, error);
    }
  } finally {
    connection.release();
  }
}

function parseStoredDiscovery(
  row: Record<string, unknown>,
): PublicPackDiscoveryDocument {
  return PublicPackDiscoveryDocumentSchema.parse({
    version: Number(row.schema_version),
    description: row.description,
    languages: row.languages,
    ecosystems: row.ecosystems,
    tags: row.tags,
    lesson_count: Number(row.lesson_count),
  });
}

async function rollbackReindex(
  connection: RegistrySqlConnection,
  originalError: unknown,
): Promise<never> {
  try {
    await connection.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Registry discovery reindex and rollback both failed",
    );
  }
  throw originalError;
}

function boundedMaxReleases(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REINDEX_RELEASES) {
    throw new Error(
      `Registry discovery reindex max releases must be between 1 and ${MAX_REINDEX_RELEASES}`,
    );
  }
  return value;
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Registry discovery reindex clock returned an invalid Date");
  }
  return value.toISOString();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Registry discovery reindex received an invalid ${label}`);
  }
  return value;
}
