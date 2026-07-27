import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  createHumanActor,
  IdentityProviderUnavailableError,
  issueApiToken,
  type RegistryActor,
} from "../src/registry-auth.js";
import {
  InMemoryRegistryRepository,
  RegistryDomainService,
  type RegistryArtifact,
  type RegistryOrganization,
  type RegistryUser,
} from "../src/registry-domain.js";
import {
  createRegistryServer,
  type RegistryActorResolver,
} from "../src/registry-server.js";
import {
  InMemoryRegistryArtifactStore,
  createRegistryPackArtifact,
} from "../src/registry-artifact.js";
import {
  BillingWebhookHandler,
  EntitlementService,
  FakeBillingProvider,
  UsageLedger,
  signWebhook,
} from "../src/registry-telemetry.js";
import { InMemoryRegistryTokenService } from "../src/registry-token-service.js";
import { MAX_REGISTRY_BEARER_TOKEN_LENGTH } from "../src/registry-protocol.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const WEBHOOK_SECRET = "local-test-secret-at-least-16-bytes";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Phase 3 Registry Fastify adapter", () => {
  it("exposes request-scoped liveness, readiness, OpenAPI, and current actor envelopes", async () => {
    const fixture = makeHttpFixture();

    const health = await fixture.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(bodyOf(health)).toMatchObject({
      data: { status: "ok" },
      request_id: expect.any(String),
    });
    expect(health.headers["x-request-id"]).toBe(bodyOf(health).request_id);
    expect(health.headers["x-content-type-options"]).toBe("nosniff");

    const openapi = await fixture.app.inject({
      method: "GET",
      url: "/v1/openapi.json",
    });
    expect(bodyOf(openapi)).toMatchObject({
      openapi: "3.1.0",
      info: { title: "PitLore Registry API" },
      paths: {
        "/v1/public/diff": {
          get: { summary: "Compare two published or yanked Pack releases" },
        },
      },
    });

    const me = await fixture.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth("owner"),
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(me).data).toMatchObject({
      kind: "human",
      tenant_id: fixture.acme.id,
      subject_id: fixture.owner.id,
      role: "owner",
    });

    const notReady = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        readiness: () => false,
      }),
    );
    const ready = await notReady.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(bodyOf(ready).data).toEqual({ status: "not_ready" });
  });

  it("reports identity provider outages as 503 instead of invalid credentials", async () => {
    const fixture = makeHttpFixture();
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: async () => {
          throw new IdentityProviderUnavailableError();
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth("temporarily-unverifiable"),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response).error.code).toBe("identity_unavailable");
  });

  it("rate limits the unauthenticated public surface without touching health or authed routes", async () => {
    const fixture = makeHttpFixture();
    let nowMs = NOW.getTime();
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        clock: () => new Date(nowMs),
        publicRateLimit: { capacity: 2, refillPerSecond: 1, maxClients: 8 },
      }),
    );

    const first = await app.inject({
      method: "GET",
      url: "/v1/public/packages",
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(second.statusCode).toBe(200);

    const limited = await app.inject({
      method: "GET",
      url: "/v1/public/packages",
    });
    expect(limited.statusCode).toBe(429);
    expect(bodyOf(limited).error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    // Liveness and protected APIs do not share the public bucket: health stays
    // green and the authenticated route spends only its independent API budget.
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const authed = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth("owner"),
    });
    expect(authed.statusCode).toBe(200);

    const otherClient = await app.inject({
      method: "GET",
      url: "/v1/public/packages",
      remoteAddress: "203.0.113.9",
    });
    expect(otherClient.statusCode).toBe(200);

    nowMs += 1_000;
    const refilled = await app.inject({
      method: "GET",
      url: "/v1/public/packages",
    });
    expect(refilled.statusCode).toBe(200);

    const disabled = track(
      createRegistryServer({
        domain: fixture.domain,
        publicRateLimit: false,
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      const response = await disabled.inject({
        method: "GET",
        url: "/v1/public/packages",
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("isolates the expensive semantic-diff budget from ordinary public reads", async () => {
    const fixture = makeHttpFixture();
    const releaseLookup = vi.spyOn(fixture.domain, "getPublicRelease");
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        semanticDiffRateLimit: {
          capacity: 2,
          refillPerSecond: 0.2,
          maxClients: 8,
        },
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
      }),
    );
    const diffUrl =
      "/v1/public/diff?package_name=acme%2Fmissing&from_version=1.0.0&to_version=2.0.0";

    const firstDiff = await app.inject({ method: "GET", url: diffUrl });
    expect(firstDiff.statusCode).toBe(404);
    const lookupsAfterFirst = releaseLookup.mock.calls.length;
    expect(lookupsAfterFirst).toBeGreaterThan(0);

    const headDiff = await app.inject({ method: "HEAD", url: diffUrl });
    expect(headDiff.statusCode).toBe(404);
    expect(releaseLookup.mock.calls.length).toBeGreaterThan(lookupsAfterFirst);
    const lookupsAfterBudget = releaseLookup.mock.calls.length;

    for (const method of ["HEAD", "GET"] as const) {
      const limitedDiff = await app.inject({ method, url: diffUrl });
      expect(limitedDiff.statusCode).toBe(429);
      if (method === "GET") {
        expect(bodyOf(limitedDiff).error.code).toBe("rate_limited");
      }
      expect(releaseLookup).toHaveBeenCalledTimes(lookupsAfterBudget);
    }

    expect(
      (await app.inject({ method: "GET", url: "/v1/public/packages" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/public/packages" }))
        .statusCode,
    ).toBe(429);
  });

  it("isolates anonymous budgets and trusts forwarded client IPs only from an allow-listed proxy", async () => {
    const fixture = makeHttpFixture();
    const webhookHandler = {
      handle: vi.fn(async () => ({ created: true, applied: true })),
    };
    const separated = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        billingWebhookHandler: webhookHandler,
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
        authRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
        billingWebhookRateLimit: {
          capacity: 1,
          refillPerSecond: 1,
          maxClients: 8,
        },
        apiRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
      }),
    );

    expect(
      (await separated.inject({ method: "GET", url: "/v1/openapi.json" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await separated.inject({ method: "GET", url: "/v1/%70ublic/packages" }))
        .statusCode,
    ).toBe(429);

    // The SSO and billing paths have independent buckets even though inject()
    // uses one loopback source address for every request.
    expect(
      (await separated.inject({ method: "GET", url: "/auth/not-configured" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await separated.inject({ method: "GET", url: "/auth/not-configured" }))
        .statusCode,
    ).toBe(429);
    expect(
      (
        await separated.inject({
          method: "POST",
          url: "/v1/billing/webhook",
          headers: {
            "content-type": "application/json",
            "x-billing-signature": "independent-budget",
          },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(200);
    expect(webhookHandler.handle).toHaveBeenCalledTimes(1);

    const firstInvalidBearer = await separated.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth("not-a-real-token"),
    });
    expect(firstInvalidBearer.statusCode).toBe(401);
    const boundedInvalidBearer = await separated.inject({
      method: "GET",
      url: `/v1/%6frgs/${fixture.acme.id}/packages`,
      headers: auth("another-invalid-token"),
    });
    expect(boundedInvalidBearer.statusCode).toBe(429);

    const forwardingIgnored = track(
      createRegistryServer({
        domain: fixture.domain,
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
      }),
    );
    expect(
      (
        await forwardingIgnored.inject({
          method: "GET",
          url: "/v1/public/packages",
          headers: { "x-forwarded-for": "203.0.113.10" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await forwardingIgnored.inject({
          method: "GET",
          url: "/v1/public/packages",
          headers: { "x-forwarded-for": "203.0.113.11" },
        })
      ).statusCode,
    ).toBe(429);

    const trustedLoopbackProxy = track(
      createRegistryServer({
        domain: fixture.domain,
        trustProxy: ["127.0.0.1/32"],
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
      }),
    );
    for (const client of ["203.0.113.20", "203.0.113.21"]) {
      expect(
        (
          await trustedLoopbackProxy.inject({
            method: "GET",
            url: "/v1/public/packages",
            headers: { "x-forwarded-for": client },
          })
        ).statusCode,
      ).toBe(200);
    }

    const untrustedPeer = track(
      createRegistryServer({
        domain: fixture.domain,
        trustProxy: ["127.0.0.1"],
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
      }),
    );
    for (const [client, expected] of [
      ["203.0.113.30", 200],
      ["203.0.113.31", 429],
    ] as const) {
      expect(
        (
          await untrustedPeer.inject({
            method: "GET",
            url: "/v1/public/packages",
            remoteAddress: "198.51.100.8",
            headers: { "x-forwarded-for": client },
          })
        ).statusCode,
      ).toBe(expected);
    }

    expect(() => createRegistryServer({ trustProxy: "0.0.0.0/0" })).toThrow(
      /cannot be \/0/,
    );
  });

  it("accepts realistic long OIDC assertions while bounding the HTTP bearer", async () => {
    const fixture = makeHttpFixture();
    const oidcAssertion = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(1_024)}.signature`;
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: (context) =>
          context.bearerToken === oidcAssertion
            ? fixture.actorResolver({ ...context, bearerToken: "owner" })
            : null,
      }),
    );

    const accepted = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth(oidcAssertion),
    });
    expect(accepted.statusCode).toBe(200);
    expect(bodyOf(accepted).data).toMatchObject({
      kind: "human",
      role: "owner",
    });

    const oversized = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth("a".repeat(MAX_REGISTRY_BEARER_TOKEN_LENGTH + 1)),
    });
    expect(oversized.statusCode).toBe(401);
    expect(oversized.headers["cache-control"]).toBe("no-store");
  });

  it("allows anonymous public search/read without exposing tenant or reviewer identities", async () => {
    const fixture = makeHttpFixture();
    await publishPublicRelease(fixture, "1.0.0");
    await publishPublicRelease(fixture, "1.10.0");
    await publishPublicRelease(fixture, "1.2.0");

    const search = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/packages?query=public",
    });
    expect(search.statusCode).toBe(200);
    expect(bodyOf(search).data.packages).toEqual([
      {
        name: "acme/public",
        visibility: "public",
        created_at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(bodyOf(search))).not.toContain(fixture.acme.id);
    expect(JSON.stringify(bodyOf(search))).not.toContain(fixture.owner.id);

    const registryPackage = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/package?name=acme%2Fpublic",
    });
    expect(registryPackage.statusCode).toBe(200);
    expect(bodyOf(registryPackage).data).toMatchObject({ name: "acme/public" });

    const release = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/release?package_name=acme%2Fpublic&version=1.0.0",
    });
    expect(release.statusCode).toBe(200);
    expect(bodyOf(release).data).toMatchObject({
      package_name: "acme/public",
      version: "1.0.0",
      status: "published",
      approval_count: 2,
    });
    expect(bodyOf(release).data).not.toHaveProperty("submitted_by");
    expect(bodyOf(release).data).not.toHaveProperty("approvals");

    const versions = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/releases?package_name=acme%2Fpublic",
    });
    expect(versions.statusCode).toBe(200);
    expect(
      bodyOf(versions).data.releases.map(
        (item: { version: string }) => item.version,
      ),
    ).toEqual(["1.10.0", "1.2.0", "1.0.0"]);
    expect(JSON.stringify(bodyOf(versions))).not.toContain(fixture.acme.id);
    expect(JSON.stringify(bodyOf(versions))).not.toContain(fixture.owner.id);

    const privateRead = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/package?name=acme%2Fprivate",
    });
    expect(privateRead.statusCode).toBe(404);
    expect(bodyOf(privateRead).error).toMatchObject({ code: "not_found" });
    const privateVersions = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/releases?package_name=acme%2Fprivate",
    });
    expect(privateVersions.statusCode).toBe(404);
  });

  it("keeps legacy search exact while exposing only verified published discovery facets", async () => {
    const fixture = makeHttpFixture();
    const prepared = makeRegistryPackArtifact("acme/public", "8.8.0");
    try {
      const legacyBeforePublish = await fixture.app.inject({
        method: "GET",
        url: "/v1/public/packages?query=public",
      });
      expect(bodyOf(legacyBeforePublish).data).toEqual({
        packages: [
          {
            name: "acme/public",
            visibility: "public",
            created_at: expect.any(String),
          },
        ],
        next_cursor: null,
      });

      const emptyFacets = await fixture.app.inject({
        method: "GET",
        url: "/v1/public/packages?query=public&include=facets",
      });
      expect(bodyOf(emptyFacets).data.packages).toEqual([
        {
          name: "acme/public",
          visibility: "public",
          created_at: expect.any(String),
          latest_version: null,
          discovery_available: false,
          description: "",
          lesson_count: 0,
          facets: { languages: [], ecosystems: [], tags: [] },
        },
      ]);

      const submitted = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: prepared.artifact.name,
          version: prepared.artifact.version,
          artifact: {
            ...artifact(8),
            integrity: prepared.artifact.integrity,
          },
          pack_artifact: prepared.artifact,
        },
      });
      expect(submitted.statusCode).toBe(201);

      const pendingFilter = await fixture.app.inject({
        method: "GET",
        url: "/v1/public/packages?language=typescript&include=facets",
      });
      expect(bodyOf(pendingFilter).data.packages).toEqual([]);

      for (const token of ["owner", "admin-one"]) {
        const approved = await fixture.app.inject({
          method: "POST",
          url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
          headers: auth(token),
          payload: {
            package_name: prepared.artifact.name,
            version: prepared.artifact.version,
          },
        });
        expect(approved.statusCode).toBe(200);
      }

      const legacyAfterPublish = await fixture.app.inject({
        method: "GET",
        url: "/v1/public/packages?query=public",
      });
      expect(bodyOf(legacyAfterPublish).data).toEqual(
        bodyOf(legacyBeforePublish).data,
      );

      const repeatedFilters = await fixture.app.inject({
        method: "GET",
        url:
          "/v1/public/packages?language=python&language=typescript" +
          "&ecosystem=irrelevant&ecosystem=node" +
          "&tag=missing&tag=http&include=facets",
      });
      expect(repeatedFilters.statusCode).toBe(200);
      expect(bodyOf(repeatedFilters).data.packages).toEqual([
        {
          name: "acme/public",
          visibility: "public",
          created_at: expect.any(String),
          latest_version: "8.8.0",
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

      const tooManyValues = await fixture.app.inject({
        method: "GET",
        url:
          "/v1/public/packages?language=a&language=b&language=c" +
          "&language=d&language=e",
      });
      expect(tooManyValues.statusCode).toBe(400);
      expect(bodyOf(tooManyValues).error.code).toBe("validation_error");

      const pendingDescription = "PENDING_DISCOVERY_DESCRIPTION_SHOULD_NOT_LEAK";
      const privateDescription = "PRIVATE_DISCOVERY_DESCRIPTION_SHOULD_NOT_LEAK";
      fixture.domain.submitRelease(
        fixture.publisher.id,
        {
          org_id: fixture.acme.id,
          package_name: "acme/public",
          version: "99.0.0",
          artifact: artifact(9),
        },
        {
          version: 1,
          description: pendingDescription,
          languages: ["pending-language"],
          ecosystems: ["pending-ecosystem"],
          tags: ["pending-only"],
          lesson_count: 1,
        },
      );
      fixture.domain.submitRelease(
        fixture.publisher.id,
        {
          org_id: fixture.acme.id,
          package_name: "acme/private",
          version: "1.0.0",
          artifact: artifact(10),
        },
        {
          version: 1,
          description: privateDescription,
          languages: ["private-language"],
          ecosystems: ["private-ecosystem"],
          tags: ["private-only"],
          lesson_count: 1,
        },
      );
      fixture.domain.approveRelease(fixture.owner.id, {
        org_id: fixture.acme.id,
        package_name: "acme/private",
        version: "1.0.0",
      });
      fixture.domain.approveRelease(fixture.adminOne.id, {
        org_id: fixture.acme.id,
        package_name: "acme/private",
        version: "1.0.0",
      });

      for (const [tag, description] of [
        ["pending-only", pendingDescription],
        ["private-only", privateDescription],
      ]) {
        const hidden = await fixture.app.inject({
          method: "GET",
          url: `/v1/public/packages?tag=${tag}&include=facets`,
        });
        expect(hidden.statusCode).toBe(200);
        expect(bodyOf(hidden).data.packages).toEqual([]);
        expect(hidden.body).not.toContain(description);
      }
    } finally {
      prepared.cleanup();
    }
  });

  it("paginates public catalogs with stable bound cursors and rejects invalid limits", async () => {
    const fixture = makeHttpFixture();
    for (const name of ["acme/alpha", "acme/zeta"]) {
      fixture.domain.createPackage(fixture.owner.id, {
        org_id: fixture.acme.id,
        name,
        visibility: "public",
      });
    }

    const packagePageOne = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/packages?query=acme%2F&limit=2",
    });
    expect(packagePageOne.statusCode).toBe(200);
    expect(
      bodyOf(packagePageOne).data.packages.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(["acme/alpha", "acme/public"]);
    const packageCursor = bodyOf(packagePageOne).data.next_cursor as string;
    expect(packageCursor).toEqual(expect.any(String));

    const packagePageTwo = await fixture.app.inject({
      method: "GET",
      url: `/v1/public/packages?query=acme%2F&limit=2&cursor=${encodeURIComponent(packageCursor)}`,
    });
    expect(bodyOf(packagePageTwo).data).toMatchObject({
      packages: [expect.objectContaining({ name: "acme/zeta" })],
      next_cursor: null,
    });

    const mismatchedCursor = await fixture.app.inject({
      method: "GET",
      url: `/v1/public/packages?query=public&cursor=${encodeURIComponent(packageCursor)}`,
    });
    expect(mismatchedCursor.statusCode).toBe(400);
    expect(bodyOf(mismatchedCursor).error.code).toBe("validation_error");

    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      await publishPublicRelease(fixture, version);
    }
    const releasePageOne = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/releases?package_name=acme%2Fpublic&limit=2",
    });
    expect(
      bodyOf(releasePageOne).data.releases.map(
        (item: { version: string }) => item.version,
      ),
    ).toEqual(["3.0.0", "2.0.0"]);
    const releaseCursor = bodyOf(releasePageOne).data.next_cursor as string;

    // A newer release inserted before the cursor must not duplicate or shift
    // the already-observed continuation.
    await publishPublicRelease(fixture, "4.0.0");
    const releasePageTwo = await fixture.app.inject({
      method: "GET",
      url: `/v1/public/releases?package_name=acme%2Fpublic&limit=2&cursor=${encodeURIComponent(releaseCursor)}`,
    });
    expect(bodyOf(releasePageTwo).data).toMatchObject({
      releases: [expect.objectContaining({ version: "1.0.0" })],
      next_cursor: null,
    });

    for (const url of [
      "/v1/public/packages?limit=101",
      "/v1/public/releases?package_name=acme%2Fpublic&limit=101",
      "/v1/public/releases?package_name=acme%2Fpublic&cursor=not-a-valid-cursor",
    ]) {
      const rejected = await fixture.app.inject({ method: "GET", url });
      expect(rejected.statusCode).toBe(400);
      expect(bodyOf(rejected).error.code).toBe("validation_error");
    }
  });

  it("paginates every authenticated collection with tenant-bound opaque cursors", async () => {
    const fixture = makeHttpFixture();
    const tokenService = new InMemoryRegistryTokenService(() => new Date(NOW));
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        tokenService,
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );

    for (const scopes of [
      ["pack:read"],
      ["pack:read", "pack:publish"],
    ] as const) {
      const issued = await app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/tokens`,
        headers: auth("admin-one"),
        payload: { scopes, expires_at: "2027-07-16T12:00:00.000Z" },
      });
      expect(issued.statusCode).toBe(201);
    }
    const tokenOne = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/tokens?limit=1`,
      headers: auth("admin-one"),
    });
    const tokenCursor = bodyOf(tokenOne).data.next_cursor as string;
    const tokenTwo = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/tokens?limit=1&cursor=${encodeURIComponent(tokenCursor)}`,
      headers: auth("admin-one"),
    });
    expect(bodyOf(tokenOne).data.tokens).toHaveLength(1);
    expect(bodyOf(tokenTwo).data.tokens).toHaveLength(1);
    expect(bodyOf(tokenTwo).data.tokens[0].token_id).not.toBe(
      bodyOf(tokenOne).data.tokens[0].token_id,
    );

    const packageOne = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/packages?limit=1`,
      headers: auth("viewer"),
    });
    expect(bodyOf(packageOne).data.packages[0].name).toBe("acme/private");
    const packageCursor = bodyOf(packageOne).data.next_cursor as string;
    fixture.domain.createPackage(fixture.owner.id, {
      org_id: fixture.acme.id,
      name: "acme/alpha",
      visibility: "private",
    });
    const packageTwo = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/packages?limit=1&cursor=${encodeURIComponent(packageCursor)}`,
      headers: auth("viewer"),
    });
    expect(bodyOf(packageTwo).data.packages[0].name).toBe("acme/public");
    const crossTenantPackage = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.beta.id}/packages?cursor=${encodeURIComponent(packageCursor)}`,
      headers: auth("beta-owner"),
    });
    expect(crossTenantPackage.statusCode).toBe(400);

    for (const version of ["1.0.0", "2.0.0"]) {
      expect((await submitRelease(fixture, version)).statusCode).toBe(201);
    }
    const releaseOne = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/releases?package_name=acme%2Fpublic&limit=1`,
      headers: auth("viewer"),
    });
    expect(bodyOf(releaseOne).data.releases[0].version).toBe("2.0.0");
    const releaseCursor = bodyOf(releaseOne).data.next_cursor as string;
    expect((await submitRelease(fixture, "3.0.0")).statusCode).toBe(201);
    const releaseTwo = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/releases?package_name=acme%2Fpublic&limit=1&cursor=${encodeURIComponent(releaseCursor)}`,
      headers: auth("viewer"),
    });
    expect(bodyOf(releaseTwo).data.releases[0].version).toBe("1.0.0");
    const crossFilterRelease = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/releases?package_name=acme%2Fprivate&cursor=${encodeURIComponent(releaseCursor)}`,
      headers: auth("viewer"),
    });
    expect(crossFilterRelease.statusCode).toBe(400);

    const memberOne = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/members?limit=2`,
      headers: auth("admin-one"),
    });
    const memberCursor = bodyOf(memberOne).data.next_cursor as string;
    const memberTwo = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/members?limit=2&cursor=${encodeURIComponent(memberCursor)}`,
      headers: auth("admin-one"),
    });
    const firstMemberIds = new Set(
      bodyOf(memberOne).data.members.map(
        (member: { user_id: string }) => member.user_id,
      ),
    );
    expect(
      bodyOf(memberTwo).data.members.every(
        (member: { user_id: string }) => !firstMemberIds.has(member.user_id),
      ),
    ).toBe(true);
    const crossTenantMember = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.beta.id}/members?cursor=${encodeURIComponent(memberCursor)}`,
      headers: auth("beta-owner"),
    });
    expect(crossTenantMember.statusCode).toBe(400);

    const auditOne = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/audit?limit=2`,
      headers: auth("admin-one"),
    });
    const auditCursor = bodyOf(auditOne).data.next_cursor as string;
    const auditTwo = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/audit?limit=2&cursor=${encodeURIComponent(auditCursor)}`,
      headers: auth("admin-one"),
    });
    const auditOneSequences = bodyOf(auditOne).data.events.map(
      (event: { sequence: number }) => event.sequence,
    );
    const auditTwoSequences = bodyOf(auditTwo).data.events.map(
      (event: { sequence: number }) => event.sequence,
    );
    expect(auditOneSequences[0]).toBeGreaterThan(auditOneSequences[1]);
    expect(Math.max(...auditTwoSequences)).toBeLessThan(
      Math.min(...auditOneSequences),
    );

    for (let index = 0; index < 48; index += 1) {
      fixture.domain.createPackage(fixture.owner.id, {
        org_id: fixture.acme.id,
        name: `acme/default-${String(index).padStart(2, "0")}`,
        visibility: "private",
      });
    }
    const defaultSized = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("viewer"),
    });
    expect(bodyOf(defaultSized).data.packages).toHaveLength(50);
    expect(bodyOf(defaultSized).data.next_cursor).toEqual(expect.any(String));

    for (const collection of [
      "tokens",
      "packages",
      "releases",
      "members",
      "audit",
    ]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/v1/orgs/${fixture.acme.id}/${collection}?limit=101`,
        headers: auth("owner"),
      });
      expect(rejected.statusCode).toBe(400);
    }
  });

  it("rejects credential-bearing provenance before it can reach a public release", async () => {
    const fixture = makeHttpFixture();
    const secret = "TOPSECRET-PROVENANCE-TOKEN";
    const submitted = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases`,
      headers: auth("publisher"),
      payload: {
        package_name: "acme/public",
        version: "9.9.9",
        artifact: {
          ...artifact(9),
          provenance: {
            ...artifact(9).provenance,
            source_url: `https://example.com/acme/public.git?access_token=${secret}`,
          },
        },
      },
    });
    expect(submitted.statusCode).toBe(400);
    expect(JSON.stringify(bodyOf(submitted))).not.toContain(secret);

    const publicRead = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/release?package_name=acme%2Fpublic&version=9.9.9",
    });
    expect(publicRead.statusCode).toBe(404);
    expect(JSON.stringify(bodyOf(publicRead))).not.toContain(secret);
  });

  it("enforces viewer, publisher, admin, and owner permissions at the HTTP boundary", async () => {
    const fixture = makeHttpFixture();

    const viewerCreate = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("viewer"),
      payload: { name: "acme/viewer-denied", visibility: "private" },
    });
    expect(viewerCreate.statusCode).toBe(403);
    expect(viewerCreate.headers["cache-control"]).toBe("no-store");

    const publisherCreate = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: { ...auth("publisher"), "content-type": "application/json" },
      payload: { name: "acme/publisher-created", visibility: "public" },
    });
    expect(publisherCreate.statusCode).toBe(201);

    const readOnlyIssued = issueApiToken(
      {
        tenantId: fixture.acme.id,
        subjectId: fixture.publisher.id,
        scopes: ["pack:read"],
        expiresAt: "2027-07-16T12:00:00.000Z",
      },
      NOW,
    );
    const readOnlyApp = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        tokenStore: { listApiTokens: () => [readOnlyIssued.record] },
        entitlements: new EntitlementService("off"),
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );
    const readOnlyCreate = await readOnlyApp.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth(readOnlyIssued.token),
      payload: { name: "acme/read-only-token-denied", visibility: "public" },
    });
    expect(readOnlyCreate.statusCode).toBe(403);

    const publisherMembers = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/members`,
      headers: auth("publisher"),
    });
    expect(publisherMembers.statusCode).toBe(403);

    const adminMembers = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/members`,
      headers: auth("admin-one"),
    });
    expect(adminMembers.statusCode).toBe(200);
    expect(bodyOf(adminMembers).data.members).toHaveLength(6);

    const adminGrantOwner = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members`,
      headers: auth("admin-one"),
      payload: { user_id: fixture.betaOwner.id, role: "owner" },
    });
    expect(adminGrantOwner.statusCode).toBe(403);
    expect(bodyOf(adminGrantOwner).error.code).toBe("forbidden");

    const adminCheckout = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/billing/checkout`,
      headers: auth("admin-one"),
      payload: { plan: "team" },
    });
    expect(adminCheckout.statusCode).toBe(403);

    const ownerCheckout = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/billing/checkout`,
      headers: auth("owner"),
      payload: { plan: "team" },
    });
    expect(ownerCheckout.statusCode).toBe(201);
    expect(bodyOf(ownerCheckout).data.url).toBe(
      `https://billing.invalid/checkout/${fixture.acme.id}/team`,
    );

    const extra = fixture.domain.registerUser({
      email: "seat-limit@example.com",
      display_name: "Seat limit",
    });
    const seatLimited = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members`,
      headers: auth("owner"),
      payload: { user_id: extra.id, role: "viewer" },
    });
    expect(seatLimited.statusCode).toBe(422);
    expect(bodyOf(seatLimited).error.code).toBe("seat_limit_exceeded");
  });

  it("returns an honest 503 when the self-hosted runtime has no billing adapter", async () => {
    const fixture = makeHttpFixture();
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );

    const checkout = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/billing/checkout`,
      headers: auth("owner"),
      payload: { plan: "team" },
    });
    expect(checkout.statusCode).toBe(503);
    expect(bodyOf(checkout).error).toMatchObject({
      code: "billing_unavailable",
      message: "Billing provider is not configured",
    });
  });

  it("enforces the private-Packs entitlement at the HTTP boundary", async () => {
    const fixture = makeHttpFixture();
    const denied = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("publisher"),
      payload: { name: "acme/private-free-denied", visibility: "private" },
    });
    expect(denied.statusCode).toBe(422);
    expect(bodyOf(denied).error.code).toBe("private_packs_not_entitled");

    fixture.entitlements.setPlan(fixture.acme.id, "team");
    const allowed = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("publisher"),
      payload: { name: "acme/private-team", visibility: "private" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("does not disguise entitlement storage outages as a seat-limit decision", async () => {
    const fixture = makeHttpFixture();
    const extra = fixture.domain.registerUser({
      email: "storage-outage@example.com",
      display_name: "Storage outage",
    });
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        entitlements: {
          billingMode: "enforced",
          planFor: () => "free",
          entitlementsFor: () => ({
            maxSeats: 3,
            monthlyEvents: 1_000,
            privatePacks: false,
            releaseApprovals: false,
          }),
          assertSeats: async () => {
            throw new Error("database unavailable");
          },
          consume: () => ({ used: 0, duplicate: false }),
        },
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members`,
      headers: auth("owner"),
      payload: { user_id: extra.id, role: "viewer" },
    });
    expect(response.statusCode).toBe(500);
    expect(bodyOf(response).error.code).toBe("internal_error");
    expect(JSON.stringify(bodyOf(response))).not.toContain(
      "database unavailable",
    );
  });

  it("serializes seat checks for generic async domain adapters", async () => {
    const fixture = makeHttpFixture();
    const candidates = ["seat-race-a", "seat-race-b", "seat-race-c"].map(
      (label) =>
        fixture.domain.registerUser({
          email: `${label}@example.com`,
          display_name: label,
        }),
    );
    const delayedDomain = new Proxy(fixture.domain, {
      get(target, property) {
        if (property === "listMembers") {
          return async (...args: Parameters<typeof target.listMembers>) => {
            const snapshot = target.listMembers(...args);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = track(
      createRegistryServer({
        domain: delayedDomain,
        actorResolver: fixture.actorResolver,
        entitlements: fixture.entitlements,
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );
    const responses = await Promise.all(
      candidates.map((candidate) =>
        app.inject({
          method: "POST",
          url: `/v1/orgs/${fixture.beta.id}/members`,
          headers: auth("beta-owner"),
          payload: { user_id: candidate.id, role: "viewer" },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 201, 422,
    ]);
    expect(
      fixture.domain.listMembers(fixture.betaOwner.id, {
        org_id: fixture.beta.id,
      }),
    ).toHaveLength(3);
  });

  it("keeps private organization reads and writes opaque across two tenants", async () => {
    const fixture = makeHttpFixture();

    const anonymous = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
    });
    expect(anonymous.statusCode).toBe(401);

    const crossTenant = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.beta.id}/packages`,
      headers: auth("owner"),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(bodyOf(crossTenant).error).toEqual({
      code: "not_found",
      message: "Resource not found",
      request_id: expect.any(String),
    });

    const crossPackage = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/package?name=beta%2Fprivate`,
      headers: auth("owner"),
    });
    expect(crossPackage.statusCode).toBe(404);
    expect(bodyOf(crossPackage).error.message).toBe("Resource not found");

    const betaRead = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.beta.id}/package?name=beta%2Fprivate`,
      headers: auth("beta-owner"),
    });
    expect(betaRead.statusCode).toBe(200);
    expect(bodyOf(betaRead).data.name).toBe("beta/private");
  });

  it("publishes only after two human non-submitter approvals and blocks service lifecycle", async () => {
    const fixture = makeHttpFixture();

    const submitted = await submitRelease(fixture, "2.0.0");
    expect(submitted.statusCode).toBe(201);
    expect(bodyOf(submitted).data.status).toBe("pending");

    const pendingPublic = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/release?package_name=acme%2Fpublic&version=2.0.0",
    });
    expect(pendingPublic.statusCode).toBe(404);

    const publisherApproval = await approveRelease(
      fixture,
      "publisher",
      "2.0.0",
    );
    expect(publisherApproval.statusCode).toBe(403);

    const serviceApproval = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
      headers: { authorization: `Bearer ${fixture.serviceToken}` },
      payload: { package_name: "acme/public", version: "2.0.0" },
    });
    expect(serviceApproval.statusCode).toBe(403);

    const first = await approveRelease(fixture, "owner", "2.0.0");
    expect(first.statusCode).toBe(200);
    expect(bodyOf(first).data).toMatchObject({ status: "pending" });
    expect(bodyOf(first).data.approvals).toHaveLength(1);

    const duplicate = await approveRelease(fixture, "owner", "2.0.0");
    expect(duplicate.statusCode).toBe(409);

    const second = await approveRelease(fixture, "admin-one", "2.0.0");
    expect(second.statusCode).toBe(200);
    expect(bodyOf(second).data).toMatchObject({ status: "published" });

    const publicRelease = await fixture.app.inject({
      method: "GET",
      url: "/v1/public/release?package_name=acme%2Fpublic&version=2.0.0",
    });
    expect(publicRelease.statusCode).toBe(200);

    const yanked = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases/yank`,
      headers: auth("admin-two"),
      payload: {
        package_name: "acme/public",
        version: "2.0.0",
        reason: "Verified detector regression",
      },
    });
    expect(yanked.statusCode).toBe(200);
    expect(bodyOf(yanked).data.status).toBe("yanked");
  });

  it("requires a verified full Pack and serves only published, non-yanked artifacts", async () => {
    const fixture = makeHttpFixture();
    const artifactStore = new InMemoryRegistryArtifactStore();
    const strictApp = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        artifactStore,
        usageLedger: fixture.usageLedger,
        clock: () => new Date(NOW),
      }),
    );
    const metadataOnly = await strictApp.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases`,
      headers: { ...auth("publisher"), "content-type": "application/json" },
      payload: {
        package_name: "acme/public",
        version: "8.0.0",
        artifact: artifact(8),
      },
    });
    expect(metadataOnly.statusCode).toBe(422);
    expect(bodyOf(metadataOnly).error.code).toBe("artifact_required");

    const prepared = makeRegistryPackArtifact("acme/public", "8.0.0");
    try {
      const submitted = await strictApp.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: prepared.artifact.name,
          version: prepared.artifact.version,
          artifact: {
            ...artifact(8),
            integrity: prepared.artifact.integrity,
          },
          pack_artifact: prepared.artifact,
        },
      });
      expect(submitted.statusCode).toBe(201);

      const pendingDownload = await strictApp.inject({
        method: "GET",
        url: "/v1/public/artifact?package_name=acme%2Fpublic&version=8.0.0",
      });
      expect(pendingDownload.statusCode).toBe(404);

      for (const token of ["owner", "admin-one"]) {
        const approved = await strictApp.inject({
          method: "POST",
          url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
          headers: auth(token),
          payload: { package_name: "acme/public", version: "8.0.0" },
        });
        expect(approved.statusCode).toBe(200);
      }
      const download = await strictApp.inject({
        method: "GET",
        url: "/v1/public/artifact?package_name=acme%2Fpublic&version=8.0.0",
      });
      expect(download.statusCode).toBe(200);
      expect(bodyOf(download).data).toMatchObject({
        format: "pitlore.pack.artifact.v1",
        name: "acme/public",
        version: "8.0.0",
        integrity: prepared.artifact.integrity,
      });
      expect(
        fixture.usageLedger.summary({ packageName: "acme/public" }),
      ).toMatchObject({
        downloads: 1,
        explicit_installs: 0,
      });

      const yanked = await strictApp.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases/yank`,
        headers: auth("admin-two"),
        payload: {
          package_name: "acme/public",
          version: "8.0.0",
          reason: "Verified unsafe behavior",
        },
      });
      expect(yanked.statusCode).toBe(200);
      const afterYank = await strictApp.inject({
        method: "GET",
        url: "/v1/public/artifact?package_name=acme%2Fpublic&version=8.0.0",
      });
      expect(afterYank.statusCode).toBe(410);
      expect(bodyOf(afterYank).error.code).toBe("release_yanked");
    } finally {
      prepared.cleanup();
    }
  });

  it("compares published and yanked artifacts without exposing or counting a download", async () => {
    const fixture = makeHttpFixture();
    const artifactStore = new InMemoryRegistryArtifactStore();
    const artifactLookup = vi.spyOn(artifactStore, "get");
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        artifactStore,
        usageLedger: fixture.usageLedger,
        clock: () => new Date(NOW),
      }),
    );
    const from = makeRegistryPackArtifact("acme/public", "8.3.0");
    const to = makeRegistryPackArtifact("acme/public", "8.4.0");
    const privateFrom = makeRegistryPackArtifact(
      "acme/private",
      "10.0.0",
      "private",
    );
    const privateTo = makeRegistryPackArtifact(
      "acme/private",
      "11.0.0",
      "private",
    );
    const publish = async (prepared: typeof from) => {
      const submitted = await app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: prepared.artifact.name,
          version: prepared.artifact.version,
          artifact: {
            ...artifact(8),
            integrity: prepared.artifact.integrity,
          },
          pack_artifact: prepared.artifact,
        },
      });
      expect(submitted.statusCode).toBe(201);
      for (const token of ["owner", "admin-one"]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
              headers: auth(token),
              payload: {
                package_name: prepared.artifact.name,
                version: prepared.artifact.version,
              },
            })
          ).statusCode,
        ).toBe(200);
      }
    };

    try {
      await publish(from);
      await publish(to);
      fixture.entitlements.setPlan(fixture.acme.id, "team");
      await publish(privateFrom);
      await publish(privateTo);
      const yanked = await app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases/yank`,
        headers: auth("admin-two"),
        payload: {
          package_name: from.artifact.name,
          version: from.artifact.version,
          reason: "Superseded by the verified replacement",
        },
      });
      expect(yanked.statusCode).toBe(200);

      const query = `package_name=${encodeURIComponent(from.artifact.name)}&from_version=${from.artifact.version}&to_version=${to.artifact.version}`;
      const compared = await app.inject({
        method: "GET",
        url: `/v1/public/diff?${query}`,
      });
      expect(compared.statusCode).toBe(200);
      expect(bodyOf(compared).data).toMatchObject({
        pack_name: from.artifact.name,
        from: { version: from.artifact.version },
        to: { version: to.artifact.version },
      });
      expect(compared.body).not.toContain("content_base64");
      expect(
        fixture.usageLedger.summary({ packageName: from.artifact.name }),
      ).toMatchObject({ downloads: 0, explicit_installs: 0 });

      const yankedDownload = await app.inject({
        method: "GET",
        url: `/v1/public/artifact?package_name=${encodeURIComponent(from.artifact.name)}&version=${from.artifact.version}`,
      });
      expect(yankedDownload.statusCode).toBe(410);

      const sameVersion = await app.inject({
        method: "GET",
        url: `/v1/public/diff?package_name=${encodeURIComponent(from.artifact.name)}&from_version=${from.artifact.version}&to_version=${from.artifact.version}`,
      });
      expect(sameVersion.statusCode).toBe(400);
      expect(bodyOf(sameVersion).error.code).toBe("validation_error");

      const lookupsBeforePrivateDiff = artifactLookup.mock.calls.length;
      const privateHidden = await app.inject({
        method: "GET",
        url: `/v1/public/diff?package_name=${encodeURIComponent(privateFrom.artifact.name)}&from_version=${privateFrom.artifact.version}&to_version=${privateTo.artifact.version}`,
      });
      expect(privateHidden.statusCode).toBe(404);
      expect(bodyOf(privateHidden).error.code).toBe("not_found");
      expect(artifactLookup).toHaveBeenCalledTimes(lookupsBeforePrivateDiff);

      const missingApp = track(
        createRegistryServer({
          domain: fixture.domain,
          artifactStore: new InMemoryRegistryArtifactStore(),
        }),
      );
      const missing = await missingApp.inject({
        method: "GET",
        url: `/v1/public/diff?${query}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(bodyOf(missing).error.code).toBe("not_found");

      const inconsistent = track(
        createRegistryServer({
          domain: fixture.domain,
          artifactStore: {
            assertCompatible: () => undefined,
            put: () => undefined,
            get: (_orgId, _name, version) =>
              version === from.artifact.version
                ? { ...from.artifact, version: "9.9.9" }
                : to.artifact,
          },
        }),
      );
      const identityFailed = await inconsistent.inject({
        method: "GET",
        url: `/v1/public/diff?${query}`,
      });
      expect(identityFailed.statusCode).toBe(500);
      expect(bodyOf(identityFailed).error).toMatchObject({
        code: "internal_error",
        message: "Internal server error",
      });

      const corrupt = track(
        createRegistryServer({
          domain: fixture.domain,
          artifactStore: {
            assertCompatible: () => undefined,
            put: () => undefined,
            get: (_orgId, _name, version) => {
              const current =
                version === from.artifact.version ? from.artifact : to.artifact;
              return { ...current, digest_hex: "f".repeat(64) };
            },
          },
        }),
      );
      const verificationFailed = await corrupt.inject({
        method: "GET",
        url: `/v1/public/diff?${query}`,
      });
      expect(verificationFailed.statusCode).toBe(500);
      expect(bodyOf(verificationFailed).error.code).toBe("internal_error");
    } finally {
      from.cleanup();
      to.cleanup();
      privateFrom.cleanup();
      privateTo.cleanup();
    }
  });

  it("accepts private artifacts only in private Registry packages", async () => {
    const fixture = makeHttpFixture();
    fixture.entitlements.setPlan(fixture.acme.id, "team");
    const privateArtifact = makeRegistryPackArtifact(
      "acme/private",
      "1.0.0",
      "private",
    );
    const mismatched = makeRegistryPackArtifact(
      "acme/public",
      "8.2.0",
      "private",
    );
    const afterDowngrade = makeRegistryPackArtifact(
      "acme/private",
      "1.0.1",
      "private",
    );
    try {
      const accepted = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: privateArtifact.artifact.name,
          version: privateArtifact.artifact.version,
          artifact: {
            ...artifact(9),
            integrity: privateArtifact.artifact.integrity,
          },
          pack_artifact: privateArtifact.artifact,
        },
      });
      expect(accepted.statusCode).toBe(201);

      fixture.entitlements.setPlan(fixture.acme.id, "free");
      const blockedRelease = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: afterDowngrade.artifact.name,
          version: afterDowngrade.artifact.version,
          artifact: {
            ...artifact(9),
            integrity: afterDowngrade.artifact.integrity,
          },
          pack_artifact: afterDowngrade.artifact,
        },
      });
      expect(blockedRelease.statusCode).toBe(422);
      expect(bodyOf(blockedRelease).error.code).toBe(
        "private_packs_not_entitled",
      );

      const blockedApproval = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
        headers: auth("owner"),
        payload: { package_name: "acme/private", version: "1.0.0" },
      });
      expect(blockedApproval.statusCode).toBe(422);
      expect(bodyOf(blockedApproval).error.code).toBe(
        "private_packs_not_entitled",
      );

      const rejected = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          package_name: mismatched.artifact.name,
          version: mismatched.artifact.version,
          artifact: {
            ...artifact(9),
            integrity: mismatched.artifact.integrity,
          },
          pack_artifact: mismatched.artifact,
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(bodyOf(rejected).error.code).toBe("invalid_artifact");
    } finally {
      privateArtifact.cleanup();
      mismatched.cleanup();
      afterDowngrade.cleanup();
    }
  });

  it("distinguishes invalid artifacts and immutable conflicts from storage outages", async () => {
    const fixture = makeHttpFixture();
    const prepared = makeRegistryPackArtifact("acme/public", "8.1.0");
    try {
      const failingDomain = new Proxy(fixture.domain, {
        get(target, property) {
          if (property === "assertArtifactCompatible") {
            return async () => {
              throw new Error("database unavailable");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const app = track(
        createRegistryServer({
          domain: failingDomain,
          actorResolver: fixture.actorResolver,
          clock: () => new Date(NOW),
        }),
      );
      const payload = {
        package_name: prepared.artifact.name,
        version: prepared.artifact.version,
        artifact: {
          ...artifact(8),
          integrity: prepared.artifact.integrity,
        },
        pack_artifact: prepared.artifact,
      };
      const outage = await app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload,
      });
      expect(outage.statusCode).toBe(500);
      expect(bodyOf(outage).error.code).toBe("internal_error");

      const invalid = await fixture.app.inject({
        method: "POST",
        url: `/v1/orgs/${fixture.acme.id}/releases`,
        headers: auth("publisher"),
        payload: {
          ...payload,
          pack_artifact: {
            ...prepared.artifact,
            digest_hex: "f".repeat(64),
          },
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(bodyOf(invalid).error.code).toBe("invalid_artifact");
    } finally {
      prepared.cleanup();
    }
  });

  it("supports reject and audit routes without exposing internal exception text", async () => {
    const fixture = makeHttpFixture();
    await submitRelease(fixture, "3.0.0");

    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases/reject`,
      headers: auth("admin-one"),
      payload: {
        package_name: "acme/public",
        version: "3.0.0",
        reason: "Provenance requires correction",
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(bodyOf(rejected).data.status).toBe("rejected");

    const laterApproval = await approveRelease(fixture, "admin-two", "3.0.0");
    expect(laterApproval.statusCode).toBe(409);
    expect(bodyOf(laterApproval).error).toMatchObject({
      code: "invalid_state",
      message: "Invalid state transition",
    });

    const audit = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/audit`,
      headers: auth("admin-one"),
    });
    expect(audit.statusCode).toBe(200);
    expect(
      bodyOf(audit).data.events.some(
        (event: { action: string }) => event.action === "release.rejected",
      ),
    ).toBe(true);
  });

  it("accepts only strict opt-in usage events and never stores raw prompt or path fields", async () => {
    const fixture = makeHttpFixture();
    await publishPublicRelease(fixture, "1.0.0");
    const endpoint = `/v1/orgs/${fixture.acme.id}/usage/events`;
    const valid = {
      event_id: "usage-event-1",
      occurred_at: NOW.toISOString(),
      kind: "retrieve",
      consent: "client-opt-in",
      package_name: "acme/public",
      package_version: "1.0.0",
      lesson_id: "tenant-id-filter",
      outcome: "used",
    };

    const recorded = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: valid,
    });
    expect(recorded.statusCode).toBe(201);
    expect(bodyOf(recorded).data).toMatchObject({ created: true });

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: valid,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(bodyOf(duplicate).data).toMatchObject({ created: false });

    const conflict = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: { ...valid, outcome: "irrelevant" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(bodyOf(conflict).error.code).toBe("conflict");

    const nonexistentVersion = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: {
        ...valid,
        event_id: "usage-event-unknown",
        package_version: "9.9.9",
      },
    });
    expect(nonexistentVersion.statusCode).toBe(404);

    const rawPrompt = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: { ...valid, event_id: "usage-event-2", raw_prompt: "secret" },
    });
    expect(rawPrompt.statusCode).toBe(400);

    const fakeDownload = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: {
        ...valid,
        event_id: "usage-event-3",
        kind: "download",
        consent: "server-observed-download",
      },
    });
    expect(fakeDownload.statusCode).toBe(400);
    expect(fixture.usageLedger.list()).toHaveLength(1);
    expect(JSON.stringify(fixture.usageLedger.list())).not.toContain("secret");

    const summary = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/usage/summary?package_name=acme%2Fpublic`,
      headers: auth("admin-one"),
    });
    expect(summary.statusCode).toBe(200);
    expect(bodyOf(summary).data).toMatchObject({
      downloads: 0,
      retrieve_calls: 1,
      check_calls: 0,
    });

    const storageFailure = vi
      .spyOn(fixture.usageLedger, "record")
      .mockImplementation(() => {
        throw new Error("private storage detail");
      });
    const failed = await fixture.app.inject({
      method: "POST",
      url: endpoint,
      headers: auth("publisher"),
      payload: { ...valid, event_id: "usage-storage-failure" },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("private storage detail");
    storageFailure.mockRestore();
  });

  it("verifies exact signed billing payloads and applies idempotent entitlement updates", async () => {
    const fixture = makeHttpFixture();
    const event = {
      event_id: "billing-event-1",
      created_at: NOW.toISOString(),
      org_id: fixture.acme.id,
      type: "subscription.updated",
      plan: "team",
      status: "active",
    };
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(NOW.getTime() / 1_000);
    const signature = signWebhook(raw, WEBHOOK_SECRET, timestamp);

    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": signature,
      },
      payload: raw,
    });
    expect(accepted.statusCode).toBe(200);
    expect(bodyOf(accepted).data).toMatchObject({
      created: true,
      applied: true,
    });

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": signature,
      },
      payload: raw,
    });
    expect(bodyOf(duplicate).data).toMatchObject({
      created: false,
      applied: false,
    });

    const entitlements = await fixture.app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/entitlements`,
      headers: auth("owner"),
    });
    expect(bodyOf(entitlements).data).toMatchObject({
      billing_mode: "enforced",
      plan: "team",
      entitlements: { privatePacks: true, releaseApprovals: true },
    });

    const invalid = await fixture.app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": signWebhook(
          `${raw} `,
          WEBHOOK_SECRET,
          timestamp,
        ),
      },
      payload: raw,
    });
    expect(invalid.statusCode).toBe(400);
    expect(bodyOf(invalid).error).toMatchObject({
      code: "invalid_webhook",
      message: "Invalid billing webhook",
    });
  });

  it("bounds billing webhook bodies and rate limits them before invoking handlers", async () => {
    const fixture = makeHttpFixture();
    const oversizedHandler = {
      handle: vi.fn(async () => ({ created: true, applied: true })),
    };
    const bounded = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        billingWebhookHandler: oversizedHandler,
        publicRateLimit: false,
      }),
    );
    const oversized = await bounded.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": "bounded-test-signature",
      },
      payload: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(bodyOf(oversized).error.code).toBe("body_too_large");
    expect(oversizedHandler.handle).not.toHaveBeenCalled();

    const limitedHandler = {
      handle: vi.fn(async () => ({ created: true, applied: true })),
    };
    const limited = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        billingWebhookHandler: limitedHandler,
        publicRateLimit: { capacity: 1, refillPerSecond: 1, maxClients: 8 },
        billingWebhookRateLimit: {
          capacity: 1,
          refillPerSecond: 1,
          maxClients: 8,
        },
      }),
    );
    expect(
      (await limited.inject({ method: "GET", url: "/v1/openapi.json" }))
        .statusCode,
    ).toBe(200);
    const acceptedBeforeLimit = await limited.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": "first-webhook",
      },
      payload: "{}",
    });
    expect(acceptedBeforeLimit.statusCode).toBe(200);
    const rejected = await limited.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-billing-signature": "rate-limited-signature",
      },
      // A body that would exceed the route parser limit still receives 429,
      // proving the onRequest limiter runs before body parsing.
      payload: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
    });
    expect(rejected.statusCode).toBe(429);
    expect(bodyOf(rejected).error.code).toBe("rate_limited");
    expect(limitedHandler.handle).toHaveBeenCalledTimes(1);
  });

  it("uses API token records without storing bearer secrets and rejects oversized bodies", async () => {
    const fixture = makeHttpFixture();
    const me = await fixture.app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: { authorization: `Bearer ${fixture.serviceToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(bodyOf(me).data).toMatchObject({
      kind: "service",
      subject_id: fixture.publisher.id,
      scopes: ["pack:publish", "pack:read"],
    });
    expect(JSON.stringify(bodyOf(me))).not.toContain(fixture.serviceToken);

    const strictBody = await fixture.app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("publisher"),
      payload: {
        name: "acme/strict-rejected",
        visibility: "private",
        owner_override: true,
      },
    });
    expect(strictBody.statusCode).toBe(400);
    expect(strictBody.headers["x-request-id"]).toBe(
      bodyOf(strictBody).error.request_id,
    );

    const smallBodyApp = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        bodyLimit: 1_024,
      }),
    );
    const oversized = await smallBodyApp.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: auth("publisher"),
      payload: {
        name: "acme/oversized",
        visibility: "private",
        padding: "x".repeat(2_000),
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(bodyOf(oversized).error.code).toBe("body_too_large");

    const routeBoundActorResolver = vi.fn(fixture.actorResolver);
    const routeBound = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: routeBoundActorResolver,
        releaseUploadRateLimit: {
          capacity: 1,
          refillPerSecond: 1,
          maxClients: 8,
        },
      }),
    );
    const oversizedTinyMutation = await routeBound.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/packages`,
      headers: {
        ...auth("publisher"),
        "content-type": "application/json",
      },
      payload: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(oversizedTinyMutation.statusCode).toBe(413);
    expect(bodyOf(oversizedTinyMutation).error.code).toBe("body_too_large");

    // Only release submission retains the larger Pack-artifact envelope. The
    // same body reaches schema validation there (400), instead of the 64 KiB
    // parser bound used by tiny mutations.
    const largeReleaseEnvelope = await routeBound.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/releases`,
      headers: {
        ...auth("publisher"),
        "content-type": "application/json",
      },
      payload: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(largeReleaseEnvelope.statusCode).toBe(400);
    const boundedSecondLargeEnvelope = await routeBound.inject({
      method: "POST",
      url: `/v1/%6frgs/${fixture.acme.id}/releases`,
      headers: {
        ...auth("publisher"),
        "content-type": "application/json",
      },
      payload: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(boundedSecondLargeEnvelope.statusCode).toBe(429);
    expect(routeBoundActorResolver).not.toHaveBeenCalled();
  });

  it("issues, lists, authenticates, and revokes scoped API tokens without exposing hashes", async () => {
    const fixture = makeHttpFixture();
    const tokenService = new InMemoryRegistryTokenService(() => new Date(NOW));
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        // An embedding may supply a legacy/read-only token source alongside
        // the lifecycle service. Tokens issued below must remain usable.
        tokenStore: { listApiTokens: () => [] },
        tokenService,
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );
    const viewerDenied = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/tokens`,
      headers: auth("viewer"),
      payload: {
        scopes: ["pack:read"],
        expires_at: "2027-07-16T12:00:00.000Z",
      },
    });
    expect(viewerDenied.statusCode).toBe(403);

    const issued = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/tokens`,
      headers: auth("admin-one"),
      payload: {
        scopes: ["pack:read", "pack:publish"],
        expires_at: "2027-07-16T12:00:00.000Z",
      },
    });
    expect(issued.statusCode).toBe(201);
    const bearer = bodyOf(issued).data.token as string;
    const tokenId = bodyOf(issued).data.record.token_id as string;
    expect(bearer).toMatch(/^pit_/);
    expect(JSON.stringify(bodyOf(issued).data.record)).not.toContain("sha256");

    const me = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth(bearer),
    });
    expect(me.statusCode).toBe(200);
    expect(bodyOf(me).data).toMatchObject({
      kind: "service",
      subject_id: fixture.adminOne.id,
    });

    const listed = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/tokens`,
      headers: auth("admin-one"),
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(bodyOf(listed))).not.toContain(bearer);
    expect(JSON.stringify(bodyOf(listed))).not.toContain("sha256");

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/tokens/${tokenId}/revoke`,
      headers: auth("admin-one"),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth(bearer),
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("changes and removes members while revoking their active service tokens", async () => {
    const fixture = makeHttpFixture();
    const app = track(
      createRegistryServer({
        domain: fixture.domain,
        actorResolver: fixture.actorResolver,
        tokenService: new InMemoryRegistryTokenService(() => new Date(NOW)),
        allowMetadataOnlyReleases: true,
        clock: () => new Date(NOW),
      }),
    );
    const issued = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/tokens`,
      headers: auth("admin-one"),
      payload: {
        scopes: ["pack:read"],
        expires_at: "2027-07-16T12:00:00.000Z",
      },
    });
    const bearer = bodyOf(issued).data.token as string;
    const before = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth(bearer),
    });
    expect(before.statusCode).toBe(200);

    const changed = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members/${fixture.adminOne.id}/role`,
      headers: auth("owner"),
      payload: { role: "viewer" },
    });
    expect(changed.statusCode).toBe(200);
    expect(bodyOf(changed).data.role).toBe("viewer");
    const afterRoleChange = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${fixture.acme.id}`,
      headers: auth(bearer),
    });
    expect(afterRoleChange.statusCode).toBe(401);

    const adminRemoveOwner = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members/${fixture.owner.id}/remove`,
      headers: auth("admin-two"),
      payload: { reason: "Privilege escalation attempt" },
    });
    expect(adminRemoveOwner.statusCode).toBe(403);

    const removed = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members/${fixture.viewer.id}/remove`,
      headers: auth("owner"),
      payload: { reason: "Member left the organization" },
    });
    expect(removed.statusCode).toBe(200);
    expect(bodyOf(removed).data.user_id).toBe(fixture.viewer.id);

    const orphaned = await app.inject({
      method: "POST",
      url: `/v1/orgs/${fixture.acme.id}/members/${fixture.owner.id}/remove`,
      headers: auth("owner"),
      payload: { reason: "Would remove the final owner" },
    });
    expect(orphaned.statusCode).toBe(409);
    expect(bodyOf(orphaned).error.code).toBe("conflict");

    const audit = await app.inject({
      method: "GET",
      url: `/v1/orgs/${fixture.acme.id}/audit`,
      headers: auth("admin-two"),
    });
    expect(
      bodyOf(audit)
        .data.events.slice(0, 2)
        .map((event: { action: string }) => event.action),
    ).toEqual(["member.removed", "member.role_changed"]);
  });
});

interface HttpFixture {
  app: FastifyInstance;
  domain: RegistryDomainService;
  usageLedger: UsageLedger;
  entitlements: EntitlementService;
  actorResolver: RegistryActorResolver;
  owner: RegistryUser;
  adminOne: RegistryUser;
  adminTwo: RegistryUser;
  publisher: RegistryUser;
  viewer: RegistryUser;
  betaOwner: RegistryUser;
  acme: RegistryOrganization;
  beta: RegistryOrganization;
  serviceToken: string;
}

function makeHttpFixture(): HttpFixture {
  const domain = new RegistryDomainService(new InMemoryRegistryRepository());
  const owner = user(domain, "owner");
  const adminOne = user(domain, "admin-one");
  const adminTwo = user(domain, "admin-two");
  const publisher = user(domain, "publisher");
  const viewer = user(domain, "viewer");
  const betaOwner = user(domain, "beta-owner");
  const acme = domain.createOrganization(owner.id, {
    slug: "acme",
    display_name: "Acme",
  });
  domain.addMember(owner.id, {
    org_id: acme.id,
    user_id: adminOne.id,
    role: "admin",
  });
  domain.addMember(owner.id, {
    org_id: acme.id,
    user_id: adminTwo.id,
    role: "admin",
  });
  domain.addMember(owner.id, {
    org_id: acme.id,
    user_id: publisher.id,
    role: "publisher",
  });
  domain.addMember(owner.id, {
    org_id: acme.id,
    user_id: viewer.id,
    role: "viewer",
  });
  domain.addMember(owner.id, {
    org_id: acme.id,
    user_id: betaOwner.id,
    role: "viewer",
  });
  domain.createPackage(owner.id, {
    org_id: acme.id,
    name: "acme/public",
    visibility: "public",
  });
  domain.createPackage(owner.id, {
    org_id: acme.id,
    name: "acme/private",
    visibility: "private",
  });

  const beta = domain.createOrganization(betaOwner.id, {
    slug: "beta",
    display_name: "Beta",
  });
  domain.createPackage(betaOwner.id, {
    org_id: beta.id,
    name: "beta/private",
    visibility: "private",
  });

  const actorByToken = new Map<string, RegistryActor>([
    ["owner", actor(owner, acme, "owner")],
    ["admin-one", actor(adminOne, acme, "admin")],
    ["admin-two", actor(adminTwo, acme, "admin")],
    ["publisher", actor(publisher, acme, "publisher")],
    ["viewer", actor(viewer, acme, "viewer")],
    ["beta-owner", actor(betaOwner, beta, "owner")],
  ]);
  const actorResolver: RegistryActorResolver = ({ bearerToken }) =>
    actorByToken.get(bearerToken) ?? null;

  const issued = issueApiToken(
    {
      tenantId: acme.id,
      subjectId: publisher.id,
      scopes: ["pack:read", "pack:publish"],
      expiresAt: "2027-07-16T12:00:00.000Z",
    },
    NOW,
  );
  const usageLedger = new UsageLedger();
  const entitlements = new EntitlementService("enforced");
  const billingWebhookHandler = new BillingWebhookHandler(
    WEBHOOK_SECRET,
    entitlements,
  );
  const app = track(
    createRegistryServer({
      domain,
      actorResolver,
      tokenStore: { listApiTokens: () => [issued.record] },
      usageLedger,
      entitlements,
      billingProvider: new FakeBillingProvider(),
      billingWebhookHandler,
      allowMetadataOnlyReleases: true,
      clock: () => new Date(NOW),
    }),
  );
  return {
    app,
    domain,
    usageLedger,
    entitlements,
    actorResolver,
    owner,
    adminOne,
    adminTwo,
    publisher,
    viewer,
    betaOwner,
    acme,
    beta,
    serviceToken: issued.token,
  };
}

function user(domain: RegistryDomainService, label: string): RegistryUser {
  return domain.registerUser({
    email: `${label}@example.com`,
    display_name: label,
  });
}

function actor(
  registryUser: RegistryUser,
  organization: RegistryOrganization,
  role: "viewer" | "publisher" | "admin" | "owner",
): RegistryActor {
  return createHumanActor(
    {
      provider: "test",
      issuer: "https://identity.example.com/",
      providerSubjectId: registryUser.id,
      subjectId: registryUser.id,
      tenantId: organization.id,
      verifiedAt: NOW.toISOString(),
    },
    role,
  );
}

function artifact(fill = 1): RegistryArtifact {
  return {
    integrity: `sha256-${Buffer.alloc(32, fill).toString("base64")}`,
    provenance: {
      source_type: "git",
      source_url: "https://example.com/acme/public.git",
      source_commit: (fill % 16).toString(16).repeat(40),
    },
  };
}

function makeRegistryPackArtifact(
  name: string,
  version: string,
  visibility: "public" | "private" = "public",
) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "pitlore-http-pack-"),
  );
  const packRoot = path.join(temporary, "pack");
  fs.cpSync(
    fileURLToPath(new URL("../packs/node-reliability", import.meta.url)),
    packRoot,
    { recursive: true },
  );
  const manifestPath = path.join(packRoot, "manifest.yaml");
  const manifest = fs
    .readFileSync(manifestPath, "utf8")
    .replace("name: pitlore/node-reliability", `name: ${name}`)
    .replace("version: 0.1.0", `version: ${version}`)
    .replace("visibility: public", `visibility: ${visibility}`);
  fs.writeFileSync(manifestPath, manifest, "utf8");
  if (visibility === "private") {
    for (const filename of fs.readdirSync(path.join(packRoot, "lessons"))) {
      const lessonPath = path.join(packRoot, "lessons", filename);
      fs.writeFileSync(
        lessonPath,
        fs
          .readFileSync(lessonPath, "utf8")
          .replace("visibility: public", "visibility: private"),
        "utf8",
      );
    }
  }
  return {
    artifact: createRegistryPackArtifact(packRoot),
    cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
  };
}

async function submitRelease(fixture: HttpFixture, version: string) {
  return fixture.app.inject({
    method: "POST",
    url: `/v1/orgs/${fixture.acme.id}/releases`,
    headers: auth("publisher"),
    payload: {
      package_name: "acme/public",
      version,
      artifact: artifact(Number(version[0]) || 1),
    },
  });
}

async function approveRelease(
  fixture: HttpFixture,
  token: string,
  version: string,
) {
  return fixture.app.inject({
    method: "POST",
    url: `/v1/orgs/${fixture.acme.id}/releases/approve`,
    headers: auth(token),
    payload: { package_name: "acme/public", version },
  });
}

async function publishPublicRelease(fixture: HttpFixture, version: string) {
  await submitRelease(fixture, version);
  await approveRelease(fixture, "owner", version);
  return approveRelease(fixture, "admin-one", version);
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function bodyOf(response: LightMyRequestResponse): any {
  return JSON.parse(response.body);
}

function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}
