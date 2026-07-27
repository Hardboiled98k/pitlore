import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRegistryPackArtifact } from "../src/registry-artifact.js";
import {
  RegistryClientError,
  RegistryHttpClient,
  MAX_REGISTRY_RESPONSE_BYTES,
  MAX_SEMANTIC_DIFF_RESPONSE_BYTES,
  parsePackReference,
} from "../src/registry-client.js";
import { loadPackLock } from "../src/pack.js";
import { initLore } from "../src/store.js";
import { MAX_REGISTRY_BEARER_TOKEN_LENGTH } from "../src/registry-protocol.js";

const OFFICIAL_PACK = fileURLToPath(
  new URL("../packs/node-reliability", import.meta.url),
);
const ORG_ID = "11111111-1111-4111-8111-111111111111";

describe("Registry HTTP client", () => {
  it("publishes a complete verified artifact without leaking its bearer", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "secret-bearer",
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return envelope({ status: "pending" }, "req-publish", 201);
      },
    });
    await client.publishPack(OFFICIAL_PACK, {
      orgId: ORG_ID,
      sourceUrl: "https://example.com/pitlore.git",
      sourceCommit: "a".repeat(40),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret-bearer",
      "content-type": "application/json",
    });
    const payload = JSON.parse(String(requests[0]?.init?.body));
    expect(payload.pack_artifact).toMatchObject({
      format: "pitlore.pack.artifact.v1",
      name: "pitlore/node-reliability",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-bearer");
  });

  it("rejects provenance URL credentials before sending a publish request", async () => {
    let requests = 0;
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "secret-bearer",
      fetchImpl: async () => {
        requests += 1;
        return envelope({ status: "pending" }, "req-publish", 201);
      },
    });

    for (const sourceUrl of [
      "https://example.com/pitlore.git?access_token=secret",
      "https://example.com/pitlore.git#access_token=secret",
    ]) {
      await expect(
        client.publishPack(OFFICIAL_PACK, {
          orgId: ORG_ID,
          sourceUrl,
          sourceCommit: "a".repeat(40),
        }),
      ).rejects.toThrow(/without query or fragment/);
    }
    expect(requests).toBe(0);
  });

  it("follows bounded public release pages while preserving the legacy list result", async () => {
    const requests: string[] = [];
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requests.push(url.toString());
        const cursor = url.searchParams.get("cursor");
        return cursor === null
          ? envelope(
              {
                releases: [publicRelease("3.0.0"), publicRelease("2.0.0")],
                next_cursor: "cursor-2",
              },
              "req-page-one",
            )
          : envelope(
              {
                releases: [publicRelease("1.0.0")],
                next_cursor: null,
              },
              "req-page-two",
            );
      },
    });

    await expect(client.listPublicReleases("acme/public")).resolves.toMatchObject([
      { version: "3.0.0" },
      { version: "2.0.0" },
      { version: "1.0.0" },
    ]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!).searchParams.get("limit")).toBeNull();
    expect(new URL(requests[1]!).searchParams.get("cursor")).toBe("cursor-2");
  });

  it("canonicalizes repeated discovery filters and keeps public search credential-free", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com/base",
      bearerToken: "private-bearer",
      fetchImpl: async (input, init) => {
        requests.push({ url: new URL(String(input)), init });
        return envelope(
          {
            packages: [publicPackageWithFacets()],
            next_cursor: null,
          },
          "req-discovery-search",
        );
      },
    });

    await expect(
      client.searchPublicPackages("acme", {
        limit: 2,
        cursor: "cursor_one",
        languages: [" TypeScript ", "GO", "go"],
        ecosystems: [" Node "],
        tags: ["Reliability", "HTTP", "http"],
        includeFacets: true,
      }),
    ).resolves.toEqual({
      packages: [publicPackageWithFacets()],
      next_cursor: null,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/base/v1/public/packages");
    expect(requests[0]?.url.searchParams.get("query")).toBe("acme");
    expect(requests[0]?.url.searchParams.get("limit")).toBe("2");
    expect(requests[0]?.url.searchParams.get("cursor")).toBe("cursor_one");
    expect(requests[0]?.url.searchParams.getAll("language")).toEqual([
      "go",
      "typescript",
    ]);
    expect(requests[0]?.url.searchParams.getAll("ecosystem")).toEqual(["node"]);
    expect(requests[0]?.url.searchParams.getAll("tag")).toEqual([
      "http",
      "reliability",
    ]);
    expect(requests[0]?.url.searchParams.get("include")).toBe("facets");
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(requests[0]?.init?.headers).toEqual({ accept: "application/json" });
  });

  it("strictly validates legacy and facet search representations", async () => {
    const invalidFacetPayloads = [
      { ...publicPackageWithFacets(), unexpected: true },
      {
        ...publicPackageWithFacets(),
        discovery_available: false,
        latest_version: null,
      },
      {
        ...publicPackageWithFacets(),
        facets: {
          ...publicPackageWithFacets().facets,
          languages: ["TypeScript"],
        },
      },
    ];
    for (const invalidPackage of invalidFacetPayloads) {
      const client = new RegistryHttpClient({
        baseUrl: "https://registry.example.com",
        fetchImpl: async () =>
          envelope(
            { packages: [invalidPackage], next_cursor: null },
            "req-invalid-discovery",
          ),
      });
      await expect(
        client.searchPublicPackages("", { includeFacets: true }),
      ).rejects.toThrow();
    }

    const legacyClient = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async () =>
        envelope(
          { packages: [publicPackageWithFacets()], next_cursor: null },
          "req-invalid-legacy",
        ),
    });
    await expect(legacyClient.searchPublicPackages()).rejects.toThrow();
  });

  it("loads a strict public semantic diff without sending its configured bearer", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com/base",
      bearerToken: "private-bearer",
      fetchImpl: async (input, init) => {
        requests.push({ url: new URL(String(input)), init });
        return envelope(publicSemanticDiff(), "req-diff");
      },
    });

    await expect(
      client.diffPublicReleases("acme/public", "1.0.0", "2.0.0"),
    ).resolves.toMatchObject({
      format: "pitlore.pack.semantic-diff.v1",
      pack_name: "acme/public",
      from: { version: "1.0.0" },
      to: { version: "2.0.0" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/base/v1/public/diff");
    expect(requests[0]?.url.searchParams.get("package_name")).toBe("acme/public");
    expect(requests[0]?.url.searchParams.get("from_version")).toBe("1.0.0");
    expect(requests[0]?.url.searchParams.get("to_version")).toBe("2.0.0");
    expect(requests[0]?.init?.headers).not.toHaveProperty("authorization");

    await expect(
      client.diffPublicReleases("acme/public", "1.0.0", "1.0.0"),
    ).rejects.toThrow(/must be different/);
    await expect(
      client.diffPublicReleases("acme/public", "latest", "2.0.0"),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);

    const invalidResponse = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async () =>
        envelope({ ...publicSemanticDiff(), unexpected: true }, "req-invalid-diff"),
    });
    await expect(
      invalidResponse.diffPublicReleases("acme/public", "1.0.0", "2.0.0"),
    ).rejects.toMatchObject({ code: "invalid_response" });

    for (const mismatched of [
      { ...publicSemanticDiff(), pack_name: "other/public" },
      {
        ...publicSemanticDiff(),
        from: { ...publicSemanticDiff().from, version: "1.1.0" },
      },
      {
        ...publicSemanticDiff(),
        to: { ...publicSemanticDiff().to, version: "2.1.0" },
      },
    ]) {
      const mismatchedResponse = new RegistryHttpClient({
        baseUrl: "https://registry.example.com",
        fetchImpl: async () => envelope(mismatched, "req-mismatched-diff"),
      });
      await expect(
        mismatchedResponse.diffPublicReleases(
          "acme/public",
          "1.0.0",
          "2.0.0",
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }

    const chunk = new Uint8Array(64 * 1024);
    let emitted = 0;
    let canceled = false;
    const oversizedDiff = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              emitted += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      oversizedDiff.diffPublicReleases("acme/public", "1.0.0", "2.0.0"),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(canceled).toBe(true);
    expect(emitted).toBeGreaterThan(MAX_SEMANTIC_DIFF_RESPONSE_BYTES);
    expect(emitted).toBeLessThan(MAX_REGISTRY_RESPONSE_BYTES);
  });

  it("provides typed bounded pages for every authenticated collection", async () => {
    const requests: URL[] = [];
    const packageOne = registryPackage("acme/alpha", "22222222-2222-4222-8222-222222222221");
    const packageTwo = registryPackage("acme/beta", "22222222-2222-4222-8222-222222222222");
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "tenant-bearer",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const cursor = url.searchParams.get("cursor");
        if (url.pathname.endsWith("/tokens")) {
          return envelope(
            {
              tokens: [registryToken()],
              next_cursor: null,
            },
            "req-tokens",
          );
        }
        if (url.pathname.endsWith("/packages")) {
          return envelope(
            cursor === null
              ? { packages: [packageOne], next_cursor: "packages-two" }
              : { packages: [packageTwo], next_cursor: null },
            "req-packages",
          );
        }
        if (url.pathname.endsWith("/releases")) {
          return envelope(
            { releases: [registryRelease()], next_cursor: null },
            "req-releases",
          );
        }
        if (url.pathname.endsWith("/members")) {
          return envelope(
            { members: [registryMember()], next_cursor: null },
            "req-members",
          );
        }
        return envelope(
          { events: [registryAuditEvent()], next_cursor: null },
          "req-audit",
        );
      },
    });

    await expect(client.listTokenPage(ORG_ID, { limit: 1 })).resolves.toMatchObject({
      tokens: [{ scopes: ["pack:read"] }],
      next_cursor: null,
    });
    await expect(client.listPackages(ORG_ID)).resolves.toEqual([
      packageOne,
      packageTwo,
    ]);
    await expect(
      client.listReleasePage(ORG_ID, { packageName: "acme/core", limit: 1 }),
    ).resolves.toMatchObject({ releases: [{ version: "1.0.0" }] });
    await expect(client.listMemberPage(ORG_ID)).resolves.toMatchObject({
      members: [{ role: "admin" }],
    });
    await expect(client.listAuditEventPage(ORG_ID)).resolves.toMatchObject({
      events: [{ sequence: 7 }],
    });

    const firstPackageRequest = requests.find(
      (url) => url.pathname.endsWith("/packages") && !url.searchParams.has("cursor"),
    );
    expect(firstPackageRequest?.searchParams.get("limit")).toBeNull();
    expect(
      requests.some(
        (url) =>
          url.pathname.endsWith("/packages") &&
          url.searchParams.get("cursor") === "packages-two",
      ),
    ).toBe(true);
    expect(
      requests.find((url) => url.pathname.endsWith("/releases"))?.searchParams.get(
        "package_name",
      ),
    ).toBe("acme/core");

    const looping = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "tenant-bearer",
      fetchImpl: async () =>
        envelope({ events: [registryAuditEvent()], next_cursor: "repeat" }, "req-loop"),
    });
    await expect(looping.listAuditEvents(ORG_ID)).rejects.toMatchObject({
      code: "invalid_pagination",
    });
  });

  it("carries a realistic long OIDC assertion but rejects oversized or malformed bearers", async () => {
    const oidcAssertion = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(1_024)}.signature`;
    let authorization: string | undefined;
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: oidcAssertion,
      fetchImpl: async (_input, init) => {
        authorization = (init?.headers as Record<string, string> | undefined)
          ?.authorization;
        return envelope({ created: true }, "req-long-oidc", 201);
      },
    });

    await client.createPackage({
      orgId: ORG_ID,
      name: "acme/oidc-pack",
      visibility: "private",
    });
    expect(authorization).toBe(`Bearer ${oidcAssertion}`);
    expect(
      () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.example.com",
          bearerToken: "a".repeat(MAX_REGISTRY_BEARER_TOKEN_LENGTH + 1),
        }),
    ).toThrow(/bearer token format is invalid/);
    expect(
      () =>
        new RegistryHttpClient({
          baseUrl: "https://registry.example.com",
          bearerToken: "not a bearer",
        }),
    ).toThrow(/bearer token format is invalid/);
  });

  it("downloads, re-verifies, installs, and locks exact Registry provenance", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-client-install-"));
    try {
      const lore = path.join(project, ".pitlore");
      initLore(lore, { name: "test/client", copySeed: false });
      const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
      const calls: string[] = [];
      let remoteStatus: "published" | "yanked" = "published";
      const client = new RegistryHttpClient({
        baseUrl: "https://registry.example.com/base",
        fetchImpl: async (input) => {
          calls.push(String(input));
          return String(input).includes("/artifact?")
            ? envelope(artifact, "req-download")
            : envelope(
                {
                  package_name: artifact.name,
                  version: artifact.version,
                  artifact: {
                    integrity: artifact.integrity,
                    provenance: {
                      source_type: "git",
                      source_url: "https://example.com/pitlore.git",
                      source_commit: "a".repeat(40),
                    },
                  },
                  status: remoteStatus,
                  yank_reason:
                    remoteStatus === "yanked" ? "Detector regression" : null,
                },
                "req-release",
              );
        },
      });
      const installed = await client.installPack(
        "pitlore/node-reliability@0.1.0",
        { loreRoot: lore },
      );
      expect(installed).toMatchObject({
        name: "pitlore/node-reliability",
        version: "0.1.0",
        usageReported: false,
      });
      expect(calls[0]).toContain(
        "/base/v1/public/artifact?package_name=pitlore%2Fnode-reliability&version=0.1.0",
      );
      expect(loadPackLock(lore).packages["pitlore/node-reliability"]?.source).toEqual({
        type: "registry",
        url: "https://registry.example.com/base/",
        org_id: null,
      });
      await expect(client.revalidateInstalledPacks(lore)).resolves.toMatchObject({
        checked: 1,
        current: ["pitlore/node-reliability@0.1.0"],
        yanked: [],
      });
      remoteStatus = "yanked";
      await expect(client.revalidateInstalledPacks(lore)).resolves.toMatchObject({
        checked: 1,
        current: [],
        yanked: [
          {
            reference: "pitlore/node-reliability@0.1.0",
            reason: "Detector regression",
          },
        ],
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports installs only with explicit opt-in and an authenticated organization", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-client-report-"));
    try {
      const lore = path.join(project, ".pitlore");
      initLore(lore, { name: "test/report", copySeed: false });
      const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
      const calls: string[] = [];
      const client = new RegistryHttpClient({
        baseUrl: "https://registry.example.com",
        bearerToken: "private-token",
        fetchImpl: async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? envelope(artifact, "req-private-download")
            : envelope({ created: true }, "req-usage", 201);
        },
      });
      const installed = await client.installPack(
        "pitlore/node-reliability@0.1.0",
        { loreRoot: lore, orgId: ORG_ID, reportUsage: true },
      );
      expect(installed.usageReported).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain(`/v1/orgs/${ORG_ID}/usage/events`);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("provisions an exact external subject without sending provider configuration", async () => {
    const requests: Array<{ url: string; body: unknown; headers: HeadersInit | undefined }> = [];
    const memberId = "22222222-2222-4222-8222-222222222222";
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "owner-oidc-assertion",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          headers: init?.headers,
        });
        return envelope(
          {
            org_id: ORG_ID,
            user_id: memberId,
            role: "admin",
            joined_at: "2026-07-16T12:00:00.000Z",
          },
          "req-provision",
          201,
        );
      },
    });

    await expect(
      client.provisionExternalMember({
        orgId: ORG_ID,
        providerSubject: "reviewer-subject",
        displayName: "Release Reviewer",
        role: "admin",
      }),
    ).resolves.toMatchObject({ user_id: memberId, role: "admin" });
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining(`/v1/orgs/${ORG_ID}/members/provision`),
      body: {
        provider_subject: "reviewer-subject",
        display_name: "Release Reviewer",
        role: "admin",
      },
      headers: expect.objectContaining({
        authorization: "Bearer owner-oidc-assertion",
      }),
    });
    expect(requests[0]?.body).not.toHaveProperty("provider");
  });

  it("reports only bounded privacy-safe CI signals with caller idempotency", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      bearerToken: "private-token",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return envelope({ created: true }, "req-signal", 201);
      },
    });
    await client.reportUsage(ORG_ID, {
      eventId: "ci:build-123:check",
      occurredAt: "2026-07-16T12:00:00.000Z",
      kind: "check",
      packageName: "pitlore/node-reliability",
      packageVersion: "0.1.0",
      lessonId: "tenant-filter",
      outcome: "hit",
    });
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining(`/v1/orgs/${ORG_ID}/usage/events`),
      body: {
        event_id: "ci:build-123:check",
        consent: "client-opt-in",
        kind: "check",
        lesson_id: "tenant-filter",
        outcome: "hit",
      },
    });
    expect(JSON.stringify(requests[0])).not.toMatch(/raw_prompt|source|file_path|email/);
    await expect(
      client.reportUsage(ORG_ID, {
        eventId: "ci:fp-without-lesson",
        occurredAt: "2026-07-16T12:00:00.000Z",
        kind: "false_positive",
        packageName: "pitlore/node-reliability",
        packageVersion: "0.1.0",
      }),
    ).rejects.toThrow(/requires a Lesson id/);
  });

  it("fails closed on insecure URLs, invalid references, timeouts, and error envelopes", async () => {
    expect(() => new RegistryHttpClient({ baseUrl: "http://registry.example.com" })).toThrow(
      /credential-free HTTPS/,
    );
    expect(() =>
      new RegistryHttpClient({ baseUrl: "https://user:secret@registry.example.com" }),
    ).toThrow(/credential-free HTTPS/);
    expect(() => parsePackReference("pitlore/node-reliability@latest")).toThrow();

    const rejected = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "release_yanked",
              message: "Release has been yanked",
              request_id: "req-yanked",
            },
          }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      rejected.downloadArtifact("pitlore/node-reliability@0.1.0"),
    ).rejects.toMatchObject({
      name: "RegistryClientError",
      statusCode: 410,
      code: "release_yanked",
      requestId: "req-yanked",
    } satisfies Partial<RegistryClientError>);

    const timedOut = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      timeoutMs: 100,
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(timedOut.searchPublicPackages()).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("cancels an oversized chunked response before buffering past the limit", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
        return Promise.reject(new Error("transport cancellation failed"));
      },
    });
    const client = new RegistryHttpClient({
      baseUrl: "https://registry.example.com",
      fetchImpl: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.searchPublicPackages()).rejects.toMatchObject({
      code: "response_too_large",
    });
    expect(canceled).toBe(true);
    expect(emitted).toBeGreaterThan(MAX_REGISTRY_RESPONSE_BYTES);
    expect(emitted).toBeLessThanOrEqual(MAX_REGISTRY_RESPONSE_BYTES + 2 * chunk.byteLength);
  });
});

function envelope(data: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify({ data, request_id: requestId }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function publicRelease(version: string) {
  return {
    package_name: "acme/public",
    version,
    status: "published",
    artifact: {
      integrity: `sha256-${Buffer.alloc(32, 7).toString("base64")}`,
      provenance: {
        source_type: "git",
        source_url: "https://example.com/acme/public.git",
        source_commit: "a".repeat(40),
      },
    },
  };
}

function publicPackageWithFacets() {
  return {
    name: "acme/public",
    visibility: "public",
    created_at: "2026-07-16T12:00:00.000Z",
    latest_version: "2.0.0",
    discovery_available: true,
    description: "Public reliability Lessons",
    lesson_count: 2,
    facets: {
      languages: ["go", "typescript"],
      ecosystems: ["node"],
      tags: ["http", "reliability"],
    },
  } as const;
}

function publicSemanticDiff() {
  const fromIntegrity = `sha256-${Buffer.alloc(32, 7).toString("base64")}`;
  const toIntegrity = `sha256-${Buffer.alloc(32, 8).toString("base64")}`;
  return {
    format: "pitlore.pack.semantic-diff.v1",
    pack_name: "acme/public",
    from: {
      version: "1.0.0",
      integrity: fromIntegrity,
      digest_hex: "a".repeat(64),
    },
    to: {
      version: "2.0.0",
      integrity: toIntegrity,
      digest_hex: "b".repeat(64),
    },
    payload: {
      canonical_payload_changed: true,
      artifact_digest_changed: true,
    },
    manifest: { changed_fields: ["description"] },
    lessons: {
      before_count: 1,
      after_count: 2,
      unchanged_count: 1,
      added: { total: 1, items: ["new-lesson"], omitted: 0 },
      removed: { total: 0, items: [], omitted: 0 },
      changed: { total: 0, items: [], omitted: 0 },
    },
  };
}

function registryPackage(name: string, id: string) {
  return {
    id,
    org_id: ORG_ID,
    name,
    visibility: "private",
    created_by: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-07-16T12:00:00.000Z",
  } as const;
}

function registryRelease() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    org_id: ORG_ID,
    package_id: "22222222-2222-4222-8222-222222222223",
    package_name: "acme/core",
    version: "1.0.0",
    artifact: publicRelease("1.0.0").artifact,
    status: "pending",
    approvals: [],
    submitted_by: "33333333-3333-4333-8333-333333333333",
    submitted_at: "2026-07-16T12:00:00.000Z",
    published_at: null,
    rejected_at: null,
    rejection_reason: null,
    yanked_at: null,
    yank_reason: null,
  } as const;
}

function registryMember() {
  return {
    org_id: ORG_ID,
    user_id: "33333333-3333-4333-8333-333333333333",
    role: "admin",
    joined_at: "2026-07-16T12:00:00.000Z",
  } as const;
}

function registryToken() {
  return {
    token_id: "55555555-5555-4555-8555-555555555555",
    prefix: "pit_abcdefghij",
    scopes: ["pack:read"],
    created_at: "2026-07-16T12:00:00.000Z",
    expires_at: "2027-07-16T12:00:00.000Z",
    revoked_at: null,
  } as const;
}

function registryAuditEvent() {
  return {
    sequence: 7,
    id: "66666666-6666-4666-8666-666666666666",
    request_id: "request-7",
    org_id: ORG_ID,
    actor_user_id: "33333333-3333-4333-8333-333333333333",
    actor_kind: "human",
    action: "package.created",
    subject_type: "package",
    subject_id: "22222222-2222-4222-8222-222222222223",
    metadata: {},
    occurred_at: "2026-07-16T12:00:00.000Z",
  } as const;
}
