import { describe, expect, it, vi } from "vitest";
import {
  PostgresRegistryRepository,
  type RegistrySqlExecutor,
} from "../src/registry-postgres.js";
import { PostgresRegistryApplication } from "../src/registry-postgres-application.js";
import { comparePublicReleaseVersions } from "../src/registry-domain.js";

const CREATED_AT = "2026-07-22T00:00:00.000Z";

describe("PostgreSQL public Registry pagination", () => {
  it("keeps arbitrary-precision numeric prereleases and build ties deterministic", () => {
    const versions = [
      "1.0.0-999999999999999999999999999999",
      "1.0.0-1000000000000000000000000000000",
      "1.0.0+build.10",
      "1.0.0+build.2",
      "1.0.0",
    ];
    expect([...versions].sort(comparePublicReleaseVersions)).toEqual([
      "1.0.0+build.2",
      "1.0.0+build.10",
      "1.0.0",
      "1.0.0-1000000000000000000000000000000",
      "1.0.0-999999999999999999999999999999",
    ]);
  });

  it("pushes package filtering, keyset continuation, and lookahead limits into SQL", async () => {
    const query = vi.fn(async () => ({
      rows: [storedDiscoveryPackage("acme/zeta")],
      rowCount: 1,
    }));
    const repository = new PostgresRegistryRepository({ query });

    await expect(
      repository.listPublicPackages({
        query: "%_literal",
        filters: {
          languages: [" TypeScript ", "GO"],
          ecosystems: ["NODE"],
          tags: ["Security"],
        },
        afterName: "acme/public",
        limit: 101,
      }),
    ).resolves.toMatchObject([
      {
        name: "acme/zeta",
        latest_version: "2.0.0",
        discovery_available: true,
        discovery: {
          languages: ["go", "typescript"],
          ecosystems: ["node"],
          tags: ["security"],
        },
      },
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("strpos(lower(p.name), $1) > 0");
    expect(sql).toContain("p.name > $2");
    expect(sql).toContain("FROM registry_release_discovery_facets");
    expect(sql).toContain("language_facet.dimension = 'language'");
    expect(sql).toContain("language_facet.value = ANY($3::text[])");
    expect(sql).toContain("ecosystem_facet.dimension = 'ecosystem'");
    expect(sql).toContain("ecosystem_facet.value = ANY($4::text[])");
    expect(sql).toContain("tag_facet.dimension = 'tag'");
    expect(sql).toContain("tag_facet.value = ANY($5::text[])");
    expect(sql).not.toContain(" && ");
    expect(sql).not.toContain("LEFT JOIN registry_releases");
    expect(sql).not.toContain("LEFT JOIN registry_release_discovery");
    expect(sql).toContain("r.status = 'published'");
    expect(sql).toContain("LIMIT $6");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "%_literal",
      "acme/public",
      ["go", "typescript"],
      ["node"],
      ["security"],
      101,
    ]);

    await repository.listPublicPackages({ query: "", limit: 51 });
    const unfilteredSql = String(query.mock.calls[1]?.[0]);
    expect(unfilteredSql).toContain("LEFT JOIN registry_releases");
    expect(unfilteredSql).toContain("LEFT JOIN registry_release_discovery");
    expect(unfilteredSql).not.toContain(
      "registry_release_discovery_facets",
    );
    expect(unfilteredSql).toContain("LIMIT $3");
    expect(query.mock.calls[1]?.[1]).toEqual(["", null, 51]);

    await expect(
      repository.listPublicPackages({ query: "", limit: 102 }),
    ).rejects.toThrow(/page read limit/i);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("loads only one bounded release page in stable SemVer order", async () => {
    const identities = [
      { id: "release-1", version: "1.0.0" },
      { id: "release-10", version: "1.10.0" },
      { id: "release-2", version: "1.2.0" },
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [storedRelease(identities[1]!), storedRelease(identities[2]!)],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [storedRelease(identities[0]!)],
        rowCount: 1,
      });
    const repository = new PostgresRegistryRepository({
      query,
    } as RegistrySqlExecutor);

    const first = await repository.listPublicReleases("acme/public", {
      limit: 2,
    });
    expect(first.map((release) => release.version)).toEqual(["1.10.0", "1.2.0"]);
    expect(query.mock.calls[0]?.[1]).toEqual(["acme/public", null, 2]);
    const firstSql = String(query.mock.calls[0]?.[0]);
    expect(firstSql).toContain(
      "r.semver_sort_key < registry_semver_sort_key($2)",
    );
    expect(firstSql).toContain("r.semver_version_tie_key < $2");
    expect(firstSql).toContain("LIMIT $3");
    expect(firstSql).not.toContain("GROUP BY release_id");

    const second = await repository.listPublicReleases("acme/public", {
      afterVersion: "1.2.0",
      limit: 2,
    });
    expect(second.map((release) => release.version)).toEqual(["1.0.0"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["acme/public", "1.2.0", 2]);
    expect(query).toHaveBeenCalledTimes(2);

    await expect(
      repository.listPublicReleases("acme/public", { limit: 102 }),
    ).rejects.toThrow(/page read limit/i);
  });

  it("loads tenant page approvals in one bounded batch and no public details", async () => {
    const orgId = "10000000-0000-4000-8000-000000000001";
    const viewerId = "20000000-0000-4000-8000-000000000001";
    const submitterId = "20000000-0000-4000-8000-000000000002";
    const releaseIds = [
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    ];
    const releases = releaseIds.map((id, index) => ({
      ...storedRelease({ id, version: `1.${1 - index}.0` }),
      org_id: orgId,
      package_id: "60000000-0000-4000-8000-000000000001",
      submitted_by: submitterId,
    }));
    const approvals = releaseIds.flatMap((releaseId, releaseIndex) =>
      [1, 2].map((reviewer) => ({
        id: `40000000-0000-4000-800${releaseIndex}-${String(reviewer).padStart(12, "0")}`,
        release_id: releaseId,
        reviewer_user_id: `50000000-0000-4000-8000-${String(reviewer).padStart(12, "0")}`,
        decision: "approved" as const,
        created_at: CREATED_AT,
      })),
    );
    const repository = {
      tenantTransaction: async (
        _tenantId: string,
        work: (tx: unknown) => Promise<unknown>,
      ) => work(repository),
      getMember: vi.fn(async () => ({
        org_id: orgId,
        user_id: viewerId,
        role: "viewer",
        created_at: CREATED_AT,
      })),
      listReleasePage: vi.fn(async () => releases),
      listReleaseApprovalsByReleaseIds: vi.fn(async () => approvals),
      listReleaseApprovals: vi.fn(async () => approvals),
      getPublicPackage: vi.fn(async () => storedPackage("acme/public")),
      listPublicReleases: vi.fn(async () => releases),
    } as unknown as PostgresRegistryRepository;
    const application = new PostgresRegistryApplication(repository);

    const tenantPage = await application.listReleasePage(viewerId, {
      org_id: orgId,
      package_name: "acme/public",
      limit: 2,
    });
    expect(tenantPage.items).toHaveLength(2);
    expect(repository.listReleaseApprovalsByReleaseIds).toHaveBeenCalledOnce();
    expect(repository.listReleaseApprovalsByReleaseIds).toHaveBeenCalledWith(
      orgId,
      releaseIds,
    );
    expect(repository.listReleaseApprovals).not.toHaveBeenCalled();

    const publicPage = await application.listPublicReleases({
      package_name: "acme/public",
      limit: 2,
    });
    expect(publicPage.items).toHaveLength(2);
    expect(publicPage.items[0]).toMatchObject({ approval_count: 2 });
    expect(publicPage.items[0]).not.toHaveProperty("approvals");
    expect(repository.listReleaseApprovals).not.toHaveBeenCalled();
    expect(repository.listReleaseApprovalsByReleaseIds).toHaveBeenCalledOnce();
  });

  it("binds every tenant approval batch id in one query", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresRegistryRepository({ query });
    await repository.listReleaseApprovalsByReleaseIds("org-1", [
      "release-1",
      "release-2",
    ]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      "org-1",
      ["release-1", "release-2"],
    ]);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "a.release_id = ANY($2::text[])",
    );
  });
});

function storedPackage(name: string) {
  return {
    id: `package-${name}`,
    org_id: "org-1",
    name,
    visibility: "public",
    description: "",
    created_by: "user-1",
    created_at: CREATED_AT,
  };
}

function storedDiscoveryPackage(name: string) {
  return {
    ...storedPackage(name),
    latest_version: "2.0.0",
    discovery_available: true,
    discovery_schema_version: 1,
    discovery_description: "Bounded public discovery",
    discovery_languages: ["go", "typescript"],
    discovery_ecosystems: ["node"],
    discovery_tags: ["security"],
    discovery_lesson_count: 2,
  };
}

function storedRelease(identity: { id: string; version: string }) {
  return {
    id: identity.id,
    org_id: "org-1",
    package_id: "package-1",
    package_name: "acme/public",
    version: identity.version,
    status: "published",
    artifact_integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`,
    artifact: {},
    manifest: {},
    provenance: {
      source_type: "git",
      source_url: "https://example.com/acme/public.git",
      source_commit: "a".repeat(40),
    },
    submitted_by: "user-1",
    created_at: CREATED_AT,
    published_at: CREATED_AT,
    rejected_at: null,
    rejection_reason: null,
    yanked_at: null,
    yank_reason: null,
    approval_count: 2,
  };
}
