import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataType, newDb } from "pg-mem";
import { enablePgMemRlsCompat } from "./helpers/pg-mem-rls.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHumanActor, type RegistryRole } from "../src/registry-auth.js";
import { createRegistryPackArtifact } from "../src/registry-artifact.js";
import { PostgresRegistryApplication } from "../src/registry-postgres-application.js";
import {
  applyRegistryMigrations,
  PostgresRegistryRepository,
  type RegistrySqlPool,
} from "../src/registry-postgres.js";
import { createRegistryServer } from "../src/registry-server.js";
import { PostgresRegistryTokenService } from "../src/registry-token-service.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const USER_IDS = {
  publisher: "20000000-0000-4000-8000-000000000001",
  adminA: "20000000-0000-4000-8000-000000000002",
  adminB: "20000000-0000-4000-8000-000000000003",
  viewer: "20000000-0000-4000-8000-000000000004",
} as const;
const NOW = "2026-07-16T15:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const OFFICIAL_PACK = fileURLToPath(
  new URL("../packs/node-reliability", import.meta.url),
);

const pools: Array<RegistrySqlPool & { end(): Promise<void> }> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("PostgreSQL Registry application", () => {
  it("persists an approved immutable artifact, audit trail, and yank across server restarts", async () => {
    const database = newDb();
  enablePgMemRlsCompat(database);
    registerMigrationAdvisoryLocks(database);
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
    pools.push(pool);
    await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    await seed(repository);
    const application = new PostgresRegistryApplication(repository, {
      clock: () => new Date(NOW),
    });
    const tokenService = new PostgresRegistryTokenService(repository, {
      clock: () => new Date(NOW),
    });
    const actors = new Map([
      ["publisher-token", actor("publisher", USER_IDS.publisher)],
      ["admin-a-token", actor("admin", USER_IDS.adminA)],
      ["owner-token", actor("owner", USER_IDS.adminA)],
      ["admin-b-token", actor("admin", USER_IDS.adminB)],
      ["admin-b-owner-token", actor("owner", USER_IDS.adminB)],
      ["viewer-token", actor("viewer", USER_IDS.viewer)],
    ]);
    const makeServer = () =>
      createRegistryServer({
        domain: application,
        tokenService,
        clock: () => new Date(NOW),
        actorResolver: ({ bearerToken }) => actors.get(bearerToken) ?? null,
      });
    const server = makeServer();

    const created = await server.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/packages`,
      headers: { authorization: "Bearer publisher-token" },
      payload: { name: "acme/persistent", visibility: "public" },
    });
    expect(created.statusCode).toBe(201);

    const artifact = makePackArtifact();
    const submitted = await server.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/releases`,
      headers: { authorization: "Bearer publisher-token" },
      payload: {
        package_name: artifact.name,
        version: artifact.version,
        artifact: {
          integrity: artifact.integrity,
          provenance: {
            source_type: "git",
            source_url: "https://example.com/acme/persistent.git",
            source_commit: SOURCE_COMMIT,
          },
        },
        pack_artifact: artifact,
      },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().data.status).toBe("pending");

    const duplicate = await server.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/releases`,
      headers: { authorization: "Bearer publisher-token" },
      payload: {
        package_name: artifact.name,
        version: artifact.version,
        artifact: {
          integrity: artifact.integrity,
          provenance: {
            source_type: "git",
            source_url: "https://example.com/acme/persistent.git",
            source_commit: SOURCE_COMMIT,
          },
        },
        pack_artifact: artifact,
      },
    });
    expect(duplicate.statusCode).toBe(409);

    for (const token of ["admin-a-token", "admin-b-token"]) {
      const approved = await server.inject({
        method: "POST",
        url: `/v1/orgs/${ORG_ID}/releases/approve`,
        headers: { authorization: `Bearer ${token}` },
        payload: { package_name: artifact.name, version: artifact.version },
      });
      expect(approved.statusCode).toBe(200);
    }
    await server.close();

    await expect(
      application.searchPublicPackages({
        query: "persistent",
        languages: ["typescript"],
        ecosystems: ["node"],
        tags: ["http"],
        limit: 50,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ name: artifact.name })],
    });

    const restarted = makeServer();
    const downloaded = await restarted.inject({
      method: "GET",
      url: `/v1/public/artifact?package_name=${encodeURIComponent(artifact.name)}&version=${artifact.version}`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.json().data).toEqual(artifact);
    const publicVersions = await restarted.inject({
      method: "GET",
      url: `/v1/public/releases?package_name=${encodeURIComponent(artifact.name)}`,
    });
    expect(publicVersions.statusCode).toBe(200);
    expect(publicVersions.json().data.releases).toEqual([
      expect.objectContaining({
        package_name: artifact.name,
        version: artifact.version,
        status: "published",
      }),
    ]);
    const publicDiscovery = await restarted.inject({
      method: "GET",
      url:
        "/v1/public/packages?query=persistent&language=typescript" +
        "&ecosystem=node&tag=http&include=facets",
    });
    expect(publicDiscovery.statusCode, publicDiscovery.body).toBe(200);
    expect(publicDiscovery.json().data.packages).toEqual([
      {
        name: artifact.name,
        visibility: "public",
        created_at: expect.any(String),
        latest_version: artifact.version,
        discovery_available: true,
        description:
          "Public Node.js and TypeScript reliability Lessons maintained by PitLore.",
        lesson_count: 3,
        facets: {
          languages: ["go", "javascript", "python", "typescript"],
          ecosystems: ["node"],
          tags: [
            "any",
            "async",
            "http",
            "promises",
            "reliability",
            "typescript",
          ],
        },
      },
    ]);

    const issued = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/tokens`,
      headers: { authorization: "Bearer admin-a-token" },
      payload: {
        scopes: ["pack:read"],
        expires_at: "2027-07-16T15:00:00.000Z",
      },
    });
    expect(issued.statusCode).toBe(201);
    const serviceBearer = issued.json().data.token as string;
    const tokenId = issued.json().data.record.token_id as string;
    const serviceRead = await restarted.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/packages`,
      headers: { authorization: `Bearer ${serviceBearer}` },
    });
    expect(serviceRead.statusCode).toBe(200);
    const revoked = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/tokens/${tokenId}/revoke`,
      headers: { authorization: "Bearer admin-a-token" },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    const revokedRead = await restarted.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/packages`,
      headers: { authorization: `Bearer ${serviceBearer}` },
    });
    expect(revokedRead.statusCode).toBe(401);

    const viewerAudit = await restarted.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/audit`,
      headers: { authorization: "Bearer viewer-token" },
    });
    expect(viewerAudit.statusCode).toBe(403);
    const audit = await restarted.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/audit`,
      headers: { authorization: "Bearer admin-a-token" },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.events.at(-1)).toMatchObject({
      subject_type: "package",
      subject_id: expect.any(String),
      actor_kind: "human",
      request_id: expect.any(String),
    });
    expect(audit.json().data.events.map((event: { action: string }) => event.action)).toEqual([
      "token.revoked",
      "token.issued",
      "release.published",
      "release.approved",
      "release.approved",
      "release.submitted",
      "package.created",
    ]);

    const yanked = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/releases/yank`,
      headers: { authorization: "Bearer admin-a-token" },
      payload: {
        package_name: artifact.name,
        version: artifact.version,
        reason: "superseded after a compatibility regression",
      },
    });
    expect(yanked.statusCode).toBe(200);
    const unavailable = await restarted.inject({
      method: "GET",
      url: `/v1/public/artifact?package_name=${encodeURIComponent(artifact.name)}&version=${artifact.version}`,
    });
    expect(unavailable.statusCode).toBe(410);
    const discoveryAfterYank = await restarted.inject({
      method: "GET",
      url: "/v1/public/packages?query=persistent&include=facets",
    });
    expect(discoveryAfterYank.statusCode).toBe(200);
    expect(discoveryAfterYank.json().data.packages).toEqual([
      {
        name: artifact.name,
        visibility: "public",
        created_at: expect.any(String),
        latest_version: null,
        discovery_available: false,
        description: "",
        lesson_count: 0,
        facets: { languages: [], ecosystems: [], tags: [] },
      },
    ]);
    const filteredAfterYank = await restarted.inject({
      method: "GET",
      url: "/v1/public/packages?query=persistent&tag=http&include=facets",
    });
    expect(filteredAfterYank.statusCode).toBe(200);
    expect(filteredAfterYank.json().data.packages).toEqual([]);

    const ownerServiceToken = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/tokens`,
      headers: { authorization: "Bearer owner-token" },
      payload: {
        scopes: ["pack:read"],
        expires_at: "2027-07-16T15:00:00.000Z",
      },
    });
    expect(ownerServiceToken.statusCode).toBe(201);
    const ownerBearer = ownerServiceToken.json().data.token as string;
    const redundantRevoke = vi
      .spyOn(tokenService, "revokeForSubject")
      .mockRejectedValue(new Error("post-commit token store outage"));
    const promoted = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/members/${USER_IDS.adminB}/role`,
      headers: { authorization: "Bearer owner-token" },
      payload: { role: "owner" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().data.role).toBe("owner");
    expect(redundantRevoke).not.toHaveBeenCalled();

    const removedOwner = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/members/${USER_IDS.adminA}/remove`,
      headers: { authorization: "Bearer admin-b-owner-token" },
      payload: { reason: "Transfer ownership to the active maintainer" },
    });
    expect(removedOwner.statusCode, removedOwner.body).toBe(200);
    expect(redundantRevoke).not.toHaveBeenCalled();
    await expect(repository.getOrganization(ORG_ID)).resolves.toMatchObject({
      owner_user_id: USER_IDS.adminB,
    });
    const revokedWithMembership = await restarted.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/packages`,
      headers: { authorization: `Bearer ${ownerBearer}` },
    });
    expect(revokedWithMembership.statusCode).toBe(401);

    const removeFinalOwner = await restarted.inject({
      method: "POST",
      url: `/v1/orgs/${ORG_ID}/members/${USER_IDS.adminB}/remove`,
      headers: { authorization: "Bearer admin-b-owner-token" },
      payload: { reason: "Would orphan the organization" },
    });
    expect(removeFinalOwner.statusCode).toBe(409);
    await restarted.close();
  });

  it("checks seat capacity under the organization mutation lock", async () => {
    const database = newDb();
  enablePgMemRlsCompat(database);
    registerMigrationAdvisoryLocks(database);
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
    pools.push(pool);
    await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    await seed(repository);
    const extraUser = "20000000-0000-4000-8000-000000000005";
    await repository.insertUser({
      id: extraUser,
      issuer: "test",
      subject: "subject-extra",
      display_name: "extra",
      created_at: NOW,
    });
    const application = new PostgresRegistryApplication(repository, {
      clock: () => new Date(NOW),
    });
    await expect(
      application.addMemberWithContext(
        USER_IDS.adminA,
        { org_id: ORG_ID, user_id: extraUser, role: "viewer" },
        { requestId: "seat-denied", actorKind: "human", maxSeats: 4 },
      ),
    ).rejects.toThrow("seat limit exceeded");
    await expect(repository.getMember(ORG_ID, extraUser)).resolves.toBeNull();

    const enforcedApplication = new PostgresRegistryApplication(repository, {
      clock: () => new Date(NOW),
      billingMode: "enforced",
    });
    await expect(
      enforcedApplication.addMemberWithContext(
        USER_IDS.adminA,
        { org_id: ORG_ID, user_id: extraUser, role: "viewer" },
        { requestId: "stale-unlimited-seat", actorKind: "human", maxSeats: null },
      ),
    ).rejects.toThrow("seat limit exceeded");
    await expect(repository.getMember(ORG_ID, extraUser)).resolves.toBeNull();

    await expect(
      enforcedApplication.provisionExternalMemberWithContext(
        USER_IDS.adminA,
        {
          org_id: ORG_ID,
          provider: "test",
          identity_issuer: "https://identity.example.com/",
          provider_subject: "new-reviewer-subject",
          display_name: "New reviewer",
          role: "admin",
        },
        { requestId: "provision-seat-denied", actorKind: "human", maxSeats: null },
      ),
    ).rejects.toThrow("seat limit exceeded");
    await expect(
      repository.getUserByExternalIdentity("test", "new-reviewer-subject"),
    ).resolves.toBeNull();

    await expect(
      application.addMemberWithContext(
        USER_IDS.adminA,
        { org_id: ORG_ID, user_id: extraUser, role: "viewer" },
        { requestId: "seat-allowed", actorKind: "human", maxSeats: 5 },
      ),
    ).resolves.toMatchObject({ user_id: extraUser, role: "viewer" });
  });

  it("executes bounded package, member, token, and audit pages in PostgreSQL", async () => {
    const database = newDb();
    enablePgMemRlsCompat(database);
    registerMigrationAdvisoryLocks(database);
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
    pools.push(pool);
    await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    await seed(repository);
    const application = new PostgresRegistryApplication(repository, {
      clock: () => new Date(NOW),
    });
    const tokenService = new PostgresRegistryTokenService(repository, {
      clock: () => new Date(NOW),
    });

    for (const name of ["acme/alpha", "acme/beta"]) {
      await application.createPackage(USER_IDS.publisher, {
        org_id: ORG_ID,
        name,
        visibility: "private",
      });
    }
    const packageOne = await application.listPackagePage(USER_IDS.viewer, {
      org_id: ORG_ID,
      limit: 1,
    });
    expect(packageOne.items.map((item) => item.name)).toEqual(["acme/alpha"]);
    expect(packageOne.next_cursor).toEqual(expect.any(String));
    const packageTwo = await application.listPackagePage(USER_IDS.viewer, {
      org_id: ORG_ID,
      limit: 1,
      cursor: packageOne.next_cursor!,
    });
    expect(packageTwo.items.map((item) => item.name)).toEqual(["acme/beta"]);

    const members = await application.listMemberPage(USER_IDS.adminA, {
      org_id: ORG_ID,
      limit: 2,
    });
    expect(members.items).toHaveLength(2);
    expect(members.next_cursor).toEqual(expect.any(String));

    const adminActor = actor("admin", USER_IDS.adminB);
    for (const requestId of ["token-page-one", "token-page-two"]) {
      await tokenService.issue(
        adminActor,
        ORG_ID,
        { scopes: ["pack:read"], expiresAt: "2027-07-16T15:00:00.000Z" },
        requestId,
      );
    }
    const tokenOne = await tokenService.listForOrganizationPage(
      adminActor,
      ORG_ID,
      { limit: 1 },
    );
    expect(tokenOne.items).toHaveLength(1);
    expect(tokenOne.next_cursor).toEqual(expect.any(String));
    const tokenTwo = await tokenService.listForOrganizationPage(
      adminActor,
      ORG_ID,
      { limit: 1, cursor: tokenOne.next_cursor! },
    );
    expect(tokenTwo.items).toHaveLength(1);
    expect(tokenTwo.items[0]?.tokenId).not.toBe(tokenOne.items[0]?.tokenId);

    const audit = await application.listAuditEventPage(USER_IDS.adminA, {
      org_id: ORG_ID,
      limit: 2,
    });
    expect(audit.items).toHaveLength(2);
    expect(audit.items[0]!.sequence).toBeGreaterThan(audit.items[1]!.sequence);
  });

  it("revalidates the current database role under lock for every token operation", async () => {
    const database = newDb();
  enablePgMemRlsCompat(database);
    registerMigrationAdvisoryLocks(database);
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
    pools.push(pool);
    await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    await seed(repository);
    const tokenService = new PostgresRegistryTokenService(repository, {
      clock: () => new Date(NOW),
    });
    const staleAdmin = actor("admin", USER_IDS.adminB);
    const issued = await tokenService.issue(
      staleAdmin,
      ORG_ID,
      { scopes: ["pack:read"], expiresAt: "2027-07-16T15:00:00.000Z" },
      "before-downgrade",
    );
    const fullScan = vi
      .spyOn(repository, "listApiTokens")
      .mockRejectedValue(new Error("full token scan must not authenticate"));
    await expect(tokenService.authenticate(issued.token, new Date(NOW))).resolves.toMatchObject({
      kind: "service",
      tokenId: issued.record.tokenId,
    });
    expect(fullScan).not.toHaveBeenCalled();
    fullScan.mockRestore();

    await repository.updateMemberRole(ORG_ID, USER_IDS.adminB, "publisher");

    await expect(
      tokenService.issue(
        staleAdmin,
        ORG_ID,
        { scopes: ["pack:read"], expiresAt: "2027-07-16T15:00:00.000Z" },
        "stale-issue",
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      tokenService.listForOrganization(staleAdmin, ORG_ID),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      tokenService.revoke(staleAdmin, ORG_ID, issued.record.tokenId, "stale-revoke"),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      tokenService.revokeForSubject(
        staleAdmin,
        ORG_ID,
        USER_IDS.adminB,
        "stale-subject-revoke",
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(repository.listApiTokens(ORG_ID)).resolves.toEqual([
      expect.objectContaining({ tokenId: issued.record.tokenId, revokedAt: null }),
    ]);
  });

  it("rejects a service token when its local user is suspended", async () => {
    const database = newDb();
    enablePgMemRlsCompat(database);
    registerMigrationAdvisoryLocks(database);
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as RegistrySqlPool & { end(): Promise<void> };
    pools.push(pool);
    await applyRegistryMigrations(pool);
    const repository = new PostgresRegistryRepository(pool);
    await seed(repository);
    const tokenService = new PostgresRegistryTokenService(repository, {
      clock: () => new Date(NOW),
    });
    const issued = await tokenService.issue(
      actor("admin", USER_IDS.adminB),
      ORG_ID,
      { scopes: ["pack:read"], expiresAt: "2027-07-16T15:00:00.000Z" },
      "before-suspension",
    );

    await expect(
      tokenService.authenticate(issued.token, new Date(NOW)),
    ).resolves.toMatchObject({
      kind: "service",
      tokenId: issued.record.tokenId,
    });
    const suspended = await pool.query(
      "UPDATE registry_users SET status = 'suspended' WHERE id = $1 RETURNING status",
      [USER_IDS.adminB],
    );
    expect(suspended.rows).toEqual([{ status: "suspended" }]);

    await expect(
      tokenService.authenticate(issued.token, new Date(NOW)),
    ).resolves.toBeNull();
    await expect(repository.listApiTokens(ORG_ID)).resolves.toEqual([
      expect.objectContaining({ tokenId: issued.record.tokenId, revokedAt: null }),
    ]);
  });
});

function registerMigrationAdvisoryLocks(database: ReturnType<typeof newDb>): void {
  database.public.registerFunction({
    name: "strpos",
    args: [DataType.text, DataType.text],
    returns: DataType.integer,
    implementation: (value: string, search: string) => value.indexOf(search) + 1,
  });
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
}

async function seed(repository: PostgresRegistryRepository): Promise<void> {
  for (const [role, id] of Object.entries(USER_IDS)) {
    await repository.insertUser({
      id,
      issuer: "test",
      subject: `subject-${role}`,
      display_name: role,
      created_at: NOW,
    });
  }
  await repository.createOrganization({
    id: ORG_ID,
    slug: "acme",
    name: "Acme",
    owner_user_id: USER_IDS.adminA,
    created_at: NOW,
  });
  await repository.addMember({
    org_id: ORG_ID,
    user_id: USER_IDS.publisher,
    role: "publisher",
    created_at: NOW,
  });
  await repository.addMember({
    org_id: ORG_ID,
    user_id: USER_IDS.adminB,
    role: "admin",
    created_at: NOW,
  });
  await repository.addMember({
    org_id: ORG_ID,
    user_id: USER_IDS.viewer,
    role: "viewer",
    created_at: NOW,
  });
}

function actor(role: RegistryRole, subjectId: string) {
  return createHumanActor(
    {
      provider: "test",
      issuer: "https://identity.example.com/",
      providerSubjectId: subjectId,
      subjectId,
      tenantId: ORG_ID,
      verifiedAt: NOW,
    },
    role,
  );
}

function makePackArtifact() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-pg-artifact-"));
  tempRoots.push(root);
  fs.cpSync(OFFICIAL_PACK, root, { recursive: true });
  const manifest = path.join(root, "manifest.yaml");
  fs.writeFileSync(
    manifest,
    fs
      .readFileSync(manifest, "utf8")
      .replace("pitlore/node-reliability", "acme/persistent")
      .replace("version: 0.1.0", "version: 2.0.0"),
  );
  return createRegistryPackArtifact(root);
}
