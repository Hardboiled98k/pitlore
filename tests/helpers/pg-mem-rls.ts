import { DataType, type IMemoryDb } from "pg-mem";
import semver from "semver";

/**
 * pg-mem cannot parse or enforce row-level security or PL/pgSQL trigger DDL,
 * so tests no-op those invariant-only migrations and provide set_config so
 * tenant-context transactions run. Their enforcement is verified against real
 * PostgreSQL in the self-host smoke test, never in pg-mem.
 */
export function enablePgMemRlsCompat(db: IMemoryDb): void {
  db.public.registerFunction({
    name: "registry_semver_sort_key",
    args: [DataType.text],
    returns: db.public.getType(DataType.text).asArray(),
    impure: false,
    implementation: (value: string) => {
      const parsed = new semver.SemVer(value, { loose: false });
      const key = [
        String(parsed.major).padStart(16, "0"),
        String(parsed.minor).padStart(16, "0"),
        String(parsed.patch).padStart(16, "0"),
      ];
      if (parsed.prerelease.length === 0) return [...key, "1:"];
      return [
        ...key,
        "0:",
        ...parsed.prerelease.map((identifier) => {
          const text = String(identifier);
          return /^\d+$/.test(text)
            ? `0:${String(text.length).padStart(3, "0")}:${text}`
            : `1:${text}`;
        }),
      ];
    },
  });
  db.public.registerFunction({
    name: "cardinality",
    args: [db.public.getType(DataType.text).asArray()],
    returns: DataType.integer,
    impure: false,
    implementation: (value: readonly string[]) => value.length,
  });
  db.public.interceptQueries((sql) => {
    if (/PITLORE_REGISTRY_PUBLIC_DISCOVERY_V1/.test(sql)) {
      // Install the relational shape used by adapter tests. pg-mem cannot
      // parse the migration's RLS, PL/pgSQL constraint triggers, or GIN DDL;
      // those invariants are exercised against PostgreSQL 17 in self-host.
      db.public.none(`
        ALTER TABLE registry_releases
          ADD CONSTRAINT registry_releases_package_id_id_key
            UNIQUE (package_id, id)
      `);
      db.public.none(`
        CREATE TABLE registry_release_discovery (
          release_id text PRIMARY KEY,
          package_id text NOT NULL,
          schema_version integer NOT NULL,
          description text NOT NULL,
          languages text[] NOT NULL,
          ecosystems text[] NOT NULL,
          tags text[] NOT NULL,
          lesson_count integer NOT NULL,
          indexed_at timestamptz NOT NULL,
          CONSTRAINT registry_release_discovery_release_fk
            FOREIGN KEY (package_id, release_id)
            REFERENCES registry_releases (package_id, id)
        )
      `);
      db.public.none(`
        CREATE TABLE registry_release_discovery_facets (
          release_id text NOT NULL,
          package_id text NOT NULL,
          dimension text NOT NULL,
          value text NOT NULL,
          PRIMARY KEY (release_id, dimension, value),
          CONSTRAINT registry_release_discovery_facets_release_fk
            FOREIGN KEY (package_id, release_id)
            REFERENCES registry_releases (package_id, id)
        )
      `);
      db.public.none(`
        ALTER TABLE registry_packages
          ADD COLUMN discovery_release_id text,
          ADD CONSTRAINT registry_packages_discovery_release_fk
            FOREIGN KEY (id, discovery_release_id)
            REFERENCES registry_releases (package_id, id)
      `);
      db.public.none(`
        CREATE INDEX registry_release_discovery_facets_lookup_idx
          ON registry_release_discovery_facets
            (dimension, value, release_id, package_id)
      `);
      return [];
    }
    if (/row\s+level\s+security|(?:create|drop)\s+policy/i.test(sql)) return [];
    if (/registry_releases_enforce_immutable_payload/i.test(sql)) return [];
    if (/CREATE\s+FUNCTION\s+registry_semver_sort_key/i.test(sql)) {
      // pg-mem cannot parse PL/pgSQL or COLLATE clauses. Install the equivalent
      // generated columns/index around the JavaScript function registered above
      // so repository keyset queries still execute in adapter tests.
      db.public.none(`
        ALTER TABLE registry_releases
          ADD COLUMN semver_sort_key text[]
            GENERATED ALWAYS AS (registry_semver_sort_key(version)) STORED,
          ADD COLUMN semver_version_tie_key text
            GENERATED ALWAYS AS (version) STORED
      `);
      db.public.none(`
        CREATE INDEX registry_releases_package_semver_keyset_idx
          ON registry_releases
            (package_id, semver_sort_key DESC, semver_version_tie_key DESC)
      `);
      return [];
    }
    return null;
  });
  db.public.registerFunction({
    name: "set_config",
    args: [DataType.text, DataType.text, DataType.bool],
    returns: DataType.text,
    impure: true,
    implementation: (_name: string, value: string) => value,
  });
}
