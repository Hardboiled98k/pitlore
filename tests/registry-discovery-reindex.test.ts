import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createRegistryPackArtifact,
  withMaterializedRegistryPackArtifact,
} from "../src/registry-artifact.js";
import { reindexRegistryReleaseDiscovery } from "../src/registry-discovery-reindex.js";
import type {
  RegistrySqlConnection,
  RegistrySqlPool,
} from "../src/registry-postgres.js";
import { buildPublicPackDiscoveryDocument } from "../src/registry-search.js";

const PACK_ROOT = fileURLToPath(
  new URL("../packs/node-reliability", import.meta.url),
);

describe("Registry discovery reindex", () => {
  it("reverifies one immutable artifact before appending bounded metadata", async () => {
    const artifact = createRegistryPackArtifact(PACK_ROOT);
    let snapshotInserted = false;
    let facetsInserted = false;
    const selectionQueries: Array<{
      readonly sql: string;
      readonly values: readonly unknown[];
    }> = [];
    const connection: RegistrySqlConnection = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [], rowCount: null };
        }
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                id: "release-1",
                package_id: "package-1",
                package_name: artifact.name,
                version: artifact.version,
                artifact,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM registry_release_discovery\n")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery_facets")) {
          expect(values?.slice(0, 2)).toEqual(["release-1", "package-1"]);
          const facets = [];
          for (let index = 2; index < (values?.length ?? 0); index += 2) {
            facets.push({
              dimension: values?.[index],
              value: values?.[index + 1],
            });
          }
          expect(facets).toEqual([
            { dimension: "language", value: "go" },
            { dimension: "language", value: "javascript" },
            { dimension: "language", value: "python" },
            { dimension: "language", value: "typescript" },
            { dimension: "ecosystem", value: "node" },
            { dimension: "tag", value: "any" },
            { dimension: "tag", value: "async" },
            { dimension: "tag", value: "http" },
            { dimension: "tag", value: "promises" },
            { dimension: "tag", value: "reliability" },
            { dimension: "tag", value: "typescript" },
          ]);
          facetsInserted = true;
          return { rows: [], rowCount: 11 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery\n")) {
          expect(values).toEqual([
            "release-1",
            "package-1",
            1,
            expect.stringContaining("Node.js"),
            ["go", "javascript", "python", "typescript"],
            ["node"],
            ["any", "async", "http", "promises", "reliability", "typescript"],
            3,
            "2026-07-22T00:00:00.000Z",
          ]);
          snapshotInserted = true;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool: RegistrySqlPool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (sql.includes("AS release_id")) {
          selectionQueries.push({ sql, values: values ?? [] });
          return snapshotInserted && facetsInserted
            ? { rows: [], rowCount: 0 }
            : {
                rows: [
                  {
                    release_id: "release-1",
                    package_id: "package-1",
                    package_name: artifact.name,
                    version: artifact.version,
                  },
                ],
                rowCount: 1,
              };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(async () => connection),
    };

    await expect(
      reindexRegistryReleaseDiscovery(pool, {
        maxReleases: 2,
        clock: () => new Date("2026-07-22T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ indexed: 1, complete: true });
    expect(snapshotInserted).toBe(true);
    expect(facetsInserted).toBe(true);
    expect(connection.release).toHaveBeenCalledOnce();
    expect(selectionQueries).toHaveLength(3);
    expect(selectionQueries[0]?.sql).not.toContain("r.id > $1");
    expect(selectionQueries[0]?.sql).not.toContain("r.artifact");
    expect(selectionQueries[0]?.sql).toContain("LIMIT $1");
    expect(selectionQueries[0]?.values).toEqual([2]);
    expect(selectionQueries[1]?.sql).toContain("r.id > $1");
    expect(selectionQueries[1]?.sql).toContain("LIMIT $2");
    expect(selectionQueries[1]?.values).toEqual(["release-1", 1]);
    expect(selectionQueries[2]?.sql).not.toContain("r.id > $1");
    expect(selectionQueries[2]?.values).toEqual([1]);
  });

  it("uses bounded keyset pages and wraps to include lower concurrent ids", async () => {
    const artifact = createRegistryPackArtifact(PACK_ROOT);
    const committed: string[] = [];
    const progress: string[] = [];
    let currentReleaseId: string | undefined;
    const connection: RegistrySqlConnection = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [], rowCount: null };
        }
        if (sql === "COMMIT") {
          if (!currentReleaseId) throw new Error("Missing locked release");
          committed.push(currentReleaseId);
          currentReleaseId = undefined;
          return { rows: [], rowCount: null };
        }
        if (sql.includes("FOR UPDATE")) {
          currentReleaseId = String(values?.[0]);
          return {
            rows: [
              {
                id: currentReleaseId,
                package_id: "package-1",
                package_name: artifact.name,
                version: artifact.version,
                artifact,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM registry_release_discovery\n")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    let selection = 0;
    const row = (releaseId: string) => ({
      release_id: releaseId,
      package_id: "package-1",
      package_name: artifact.name,
      version: artifact.version,
    });
    const pool: RegistrySqlPool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (!sql.includes("AS release_id")) {
          throw new Error(`Unexpected pool query: ${sql}`);
        }
        selection += 1;
        if (selection === 1) {
          expect(sql).not.toContain("r.id > $1");
          expect(values).toEqual([5]);
          return { rows: [row("release-b"), row("release-c")], rowCount: 2 };
        }
        if (selection === 2) {
          expect(sql).toContain("r.id > $1");
          expect(values).toEqual(["release-c", 3]);
          return { rows: [], rowCount: 0 };
        }
        if (selection === 3) {
          expect(sql).not.toContain("r.id > $1");
          expect(values).toEqual([3]);
          return { rows: [row("release-a")], rowCount: 1 };
        }
        if (selection === 4) {
          expect(sql).toContain("r.id > $1");
          expect(values).toEqual(["release-a", 2]);
          return { rows: [], rowCount: 0 };
        }
        expect(sql).not.toContain("r.id > $1");
        expect(values).toEqual([2]);
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => connection),
    };

    await expect(
      reindexRegistryReleaseDiscovery(pool, {
        maxReleases: 5,
        onProgress: ({ package_name, version, indexed }) => {
          progress.push(`${package_name}@${version}:${indexed}`);
        },
      }),
    ).resolves.toEqual({ indexed: 3, complete: true });
    expect(committed).toEqual(["release-b", "release-c", "release-a"]);
    expect(progress).toEqual([
      `${artifact.name}@${artifact.version}:1`,
      `${artifact.name}@${artifact.version}:2`,
      `${artifact.name}@${artifact.version}:3`,
    ]);
    expect(selection).toBe(5);
  });

  it("stops at maxReleases and reports remaining work without another page", async () => {
    const artifact = createRegistryPackArtifact(PACK_ROOT);
    const committed: string[] = [];
    let currentReleaseId: string | undefined;
    const connection: RegistrySqlConnection = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [], rowCount: null };
        }
        if (sql === "COMMIT") {
          if (!currentReleaseId) throw new Error("Missing locked release");
          committed.push(currentReleaseId);
          currentReleaseId = undefined;
          return { rows: [], rowCount: null };
        }
        if (sql.includes("FOR UPDATE")) {
          currentReleaseId = String(values?.[0]);
          return {
            rows: [
              {
                id: currentReleaseId,
                package_id: "package-1",
                package_name: artifact.name,
                version: artifact.version,
                artifact,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM registry_release_discovery\n")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    let selectionCount = 0;
    const pool: RegistrySqlPool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (sql.includes("AS release_id")) {
          selectionCount += 1;
          expect(values).toEqual([2]);
          return {
            rows: ["release-1", "release-2"].map((releaseId) => ({
              release_id: releaseId,
              package_id: "package-1",
              package_name: artifact.name,
              version: artifact.version,
            })),
            rowCount: 2,
          };
        }
        if (sql.startsWith("SELECT 1")) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(async () => connection),
    };

    await expect(
      reindexRegistryReleaseDiscovery(pool, { maxReleases: 2 }),
    ).resolves.toEqual({ indexed: 2, complete: false });
    expect(selectionCount).toBe(1);
    expect(committed).toEqual(["release-1", "release-2"]);
  });

  it("bounds verified concurrent wins and derives complete from remaining work", async () => {
    const artifact = createRegistryPackArtifact(PACK_ROOT);
    const discovery = withMaterializedRegistryPackArtifact(
      artifact,
      buildPublicPackDiscoveryDocument,
    );
    const clock = vi.fn(() => new Date("2026-07-22T00:00:00.000Z"));
    const committed: string[] = [];
    const inserted: string[] = [];
    let currentReleaseId: string | undefined;
    const connection: RegistrySqlConnection = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [], rowCount: null };
        }
        if (sql === "COMMIT") {
          if (!currentReleaseId) throw new Error("Missing locked release");
          committed.push(currentReleaseId);
          currentReleaseId = undefined;
          return { rows: [], rowCount: null };
        }
        if (sql.includes("FOR UPDATE")) {
          expect(sql).toContain("r.artifact");
          currentReleaseId = String(values?.[0]);
          return {
            rows: [
              {
                id: currentReleaseId,
                package_id: "package-1",
                package_name: artifact.name,
                version: artifact.version,
                artifact,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM registry_release_discovery\n")) {
          return currentReleaseId === "release-concurrent"
            ? {
                rows: [
                  {
                    schema_version: discovery.version,
                    description: discovery.description,
                    languages: discovery.languages,
                    ecosystems: discovery.ecosystems,
                    tags: discovery.tags,
                    lesson_count: discovery.lesson_count,
                  },
                ],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery\n")) {
          if (!currentReleaseId) throw new Error("Missing locked release");
          inserted.push(currentReleaseId);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO registry_release_discovery_facets")) {
          return { rows: [], rowCount: 11 };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    let selection = 0;
    const candidate = (releaseId: string) => ({
      release_id: releaseId,
      package_id: "package-1",
      package_name: artifact.name,
      version: artifact.version,
    });
    const pool: RegistrySqlPool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (sql.includes("AS release_id")) {
          expect(sql).not.toContain("r.artifact");
          selection += 1;
          expect(selection).toBe(1);
          expect(values).toEqual([1]);
          return { rows: [candidate("release-concurrent")], rowCount: 1 };
        }
        if (sql.startsWith("SELECT 1")) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(async () => connection),
    };

    await expect(
      reindexRegistryReleaseDiscovery(pool, {
        maxReleases: 1,
        clock,
      }),
    ).resolves.toEqual({ indexed: 0, complete: false });
    expect(selection).toBe(1);
    expect(committed).toEqual(["release-concurrent"]);
    expect(inserted).toEqual([]);
    expect(clock).not.toHaveBeenCalled();
  });

  it("rolls back and stops the ordered pass when one artifact fails verification", async () => {
    const artifact = createRegistryPackArtifact(PACK_ROOT);
    const transactionEvents: string[] = [];
    const connection: RegistrySqlConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          transactionEvents.push(sql);
          return { rows: [], rowCount: null };
        }
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                id: "release-1",
                package_id: "package-1",
                package_name: artifact.name,
                version: artifact.version,
                artifact: { ...artifact, version: "9.9.9" },
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    let selectionCount = 0;
    const pool: RegistrySqlPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (sql.includes("AS release_id")) {
          selectionCount += 1;
          return {
            rows: ["release-1", "release-2"].map((releaseId) => ({
              release_id: releaseId,
              package_id: "package-1",
              package_name: artifact.name,
              version: artifact.version,
            })),
            rowCount: 2,
          };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(async () => connection),
    };

    await expect(
      reindexRegistryReleaseDiscovery(pool, { maxReleases: 2 }),
    ).rejects.toThrow(/artifact identity mismatch/);
    expect(selectionCount).toBe(1);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(transactionEvents).toEqual(["BEGIN", "ROLLBACK"]);
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("refuses runtime credentials and invalid unbounded requests", async () => {
    const pool: RegistrySqlPool = {
      query: vi.fn(async () => ({
        rows: [{ allowed: false }],
        rowCount: 1,
      })),
      connect: vi.fn(),
    };
    await expect(reindexRegistryReleaseDiscovery(pool)).rejects.toThrow(
      /migration-owner/,
    );
    await expect(
      reindexRegistryReleaseDiscovery(pool, { maxReleases: 100_001 }),
    ).rejects.toThrow(/between 1 and 100000/);

    const selectionLimits: unknown[][] = [];
    const privilegedPool: RegistrySqlPool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("AS allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        if (sql.includes("AS release_id")) {
          selectionLimits.push(values ?? []);
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(),
    };
    await expect(
      reindexRegistryReleaseDiscovery(privilegedPool, {
        maxReleases: 100_000,
      }),
    ).resolves.toEqual({ indexed: 0, complete: true });
    expect(selectionLimits).toEqual([[128]]);
  });
});
