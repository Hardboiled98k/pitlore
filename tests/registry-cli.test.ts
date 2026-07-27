import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHumanActor, type RegistryActor } from "../src/registry-auth.js";
import {
  InMemoryRegistryRepository,
  RegistryDomainService,
  type RegistryOrganization,
  type RegistryUser,
} from "../src/registry-domain.js";
import { loadPackLock } from "../src/pack.js";
import { createRegistryServer } from "../src/registry-server.js";
import { initLore } from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const execute = promisify(execFile);
const NOW = "2026-07-16T17:00:00.000Z";
const roots: string[] = [];
const apps: ReturnType<typeof createRegistryServer>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Registry CLI end to end", () => {
  it("creates, publishes, approves, searches, installs, locks, and honors yank", async () => {
    const domain = new RegistryDomainService(new InMemoryRegistryRepository(), {
      clock: () => new Date(NOW),
    });
    const owner = user(domain, "owner");
    const admin = user(domain, "admin");
    const publisher = user(domain, "publisher");
    const organization = domain.createOrganization(owner.id, {
      slug: "acme",
      display_name: "Acme",
    });
    domain.addMember(owner.id, {
      org_id: organization.id,
      user_id: admin.id,
      role: "admin",
    });
    domain.addMember(owner.id, {
      org_id: organization.id,
      user_id: publisher.id,
      role: "publisher",
    });
    const actors = new Map<string, RegistryActor>([
      ["owner", actor(owner, organization, "owner")],
      ["admin", actor(admin, organization, "admin")],
      ["publisher", actor(publisher, organization, "publisher")],
    ]);
    const app = createRegistryServer({
      domain,
      actorResolver: ({ bearerToken }) => actors.get(bearerToken) ?? null,
      clock: () => new Date(NOW),
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const cwd = makeRoot("pitlore-registry-cli-");
    initLore(path.join(cwd, ".pitlore"), {
      name: "test/registry-cli",
      copySeed: false,
    });
    const packRoot = makePack("acme/cli", "1.2.3");

    await runCli(
      cwd,
      [
        "registry",
        "create-package",
        "acme/cli",
        "--org",
        organization.id,
        "--visibility",
        "public",
        "--url",
        registryUrl,
      ],
      "publisher",
    );
    await runCli(
      cwd,
      [
        "registry",
        "publish",
        packRoot,
        "--org",
        organization.id,
        "--source-url",
        "https://example.com/acme/cli.git",
        "--source-commit",
        "a".repeat(40),
        "--url",
        registryUrl,
      ],
      "publisher",
    );
    for (const token of ["owner", "admin"]) {
      await runCli(
        cwd,
        [
          "registry",
          "approve",
          "acme/cli@1.2.3",
          "--org",
          organization.id,
          "--url",
          registryUrl,
        ],
        token,
      );
    }

    const searched = await runCli(cwd, ["registry", "search", "cli", "--url", registryUrl]);
    expect(JSON.parse(searched.stdout)).toMatchObject({
      packages: [{ name: "acme/cli", visibility: "public" }],
    });
    expect(Object.keys(JSON.parse(searched.stdout).packages[0])).toEqual([
      "name",
      "visibility",
      "created_at",
    ]);

    const explicitlyFaceted = await runCli(cwd, [
      "registry",
      "search",
      "cli",
      "--facets",
      "--url",
      registryUrl,
    ]);
    expect(JSON.parse(explicitlyFaceted.stdout)).toMatchObject({
      packages: [
        {
          name: "acme/cli",
          latest_version: "1.2.3",
          discovery_available: true,
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
      ],
    });

    const automaticallyFaceted = await runCli(cwd, [
      "registry",
      "search",
      "cli",
      "--language",
      "missing-language",
      "--language",
      "TypeScript",
      "--ecosystem",
      "missing-ecosystem",
      "--ecosystem",
      "Node",
      "--tag",
      "missing-tag",
      "--tag",
      "HTTP",
      "--url",
      registryUrl,
    ]);
    expect(JSON.parse(automaticallyFaceted.stdout)).toMatchObject({
      packages: [
        {
          name: "acme/cli",
          latest_version: "1.2.3",
          discovery_available: true,
          facets: {
            languages: expect.arrayContaining(["typescript"]),
            ecosystems: ["node"],
            tags: expect.arrayContaining(["http"]),
          },
        },
      ],
    });

    for (const [argumentsList, expectedError] of [
      [
        [
          "--language",
          "a",
          "--language",
          "b",
          "--language",
          "c",
          "--language",
          "d",
          "--language",
          "e",
        ],
        "at most 4",
      ],
      [["--language", ""], "must not be empty"],
      [["--tag", "x".repeat(65)], "at most 64 characters"],
    ] as const) {
      await expect(
        runCli(cwd, [
          "registry",
          "search",
          "cli",
          ...argumentsList,
          "--url",
          registryUrl,
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(expectedError),
      });
    }
    const installed = await runCli(cwd, [
      "registry",
      "install",
      "acme/cli@1.2.3",
      "--url",
      registryUrl,
    ]);
    expect(installed.stdout).toContain("Installed acme/cli@1.2.3");
    expect(loadPackLock(path.join(cwd, ".pitlore")).packages["acme/cli"]?.source).toEqual({
      type: "registry",
      url: `${registryUrl}/`,
      org_id: null,
    });
    const synchronized = await runCli(cwd, [
      "registry",
      "sync",
      "--url",
      registryUrl,
      "--json",
    ]);
    expect(JSON.parse(synchronized.stdout)).toMatchObject({
      checked: 1,
      current: ["acme/cli@1.2.3"],
      yanked: [],
    });

    await runCli(
      cwd,
      [
        "registry",
        "yank",
        "acme/cli@1.2.3",
        "--org",
        organization.id,
        "--reason",
        "verified compatibility regression",
        "--url",
        registryUrl,
      ],
      "admin",
    );
    await expect(
      runCli(cwd, ["registry", "sync", "--url", registryUrl]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("installed Registry Pack release(s) have been yanked"),
    });
    await expect(
      runCli(cwd, [
        "registry",
        "install",
        "acme/cli@1.2.3",
        "--url",
        registryUrl,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Release has been yanked") });
  }, 30_000);

  it("documents and bounds discovery search and migration-owner reindex routing", async () => {
    const cwd = makeRoot("pitlore-registry-cli-help-");
    const searchHelp = await runCli(cwd, ["registry", "search", "--help"]);
    expect(searchHelp.stdout).toContain(
      "Search public Packs by name and verified release facets",
    );
    expect(searchHelp.stdout).toContain("--language <value>");
    expect(searchHelp.stdout).toContain("--ecosystem <value>");
    expect(searchHelp.stdout).toContain("--tag <value>");
    expect(searchHelp.stdout).toContain("--facets");
    expect(searchHelp.stdout).toContain("repeat up to four");

    const reindexHelp = await runCli(cwd, [
      "registry",
      "reindex-discovery",
      "--help",
    ]);
    expect(reindexHelp.stdout).toContain(
      "Reverify immutable artifacts and append missing public-discovery metadata",
    );
    expect(reindexHelp.stdout).toContain("--database-url-env <name>");
    expect(reindexHelp.stdout).toContain("migration-owner");
    expect(reindexHelp.stdout).toContain("PITLORE_REGISTRY_DATABASE_URL");
    expect(reindexHelp.stdout).toContain("--use-split-migration-owner-env");
    expect(reindexHelp.stdout).toContain("role is still verified");
    expect(reindexHelp.stdout).toContain("--max-releases <count>");
    expect(reindexHelp.stdout).toContain('default: "1000"');

    await expect(
      runCli(cwd, [
        "registry",
        "reindex-discovery",
        "--database-url-env",
        "invalid-name",
        "--max-releases",
        "1",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Registry database URL environment variable name is invalid",
      ),
    });

    await expect(
      runCli(
        cwd,
        [
          "registry",
          "reindex-discovery",
          "--database-url-env",
          "PITLORE_MIGRATION_OWNER_URL",
          "--max-releases",
          "1",
        ],
        undefined,
        {
          PITLORE_MIGRATION_OWNER_URL: "",
          PITLORE_REGISTRY_DATABASE_URL: "",
          PITLORE_REGISTRY_DATABASE_HOST: "runtime-db.example.com",
          PITLORE_REGISTRY_DATABASE_NAME: "pitlore",
          PITLORE_REGISTRY_DATABASE_USER: "pitlore-runtime",
          PITLORE_REGISTRY_DATABASE_PASSWORD: "runtime-secret",
          PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: "",
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Registry migration-owner database URL is required in PITLORE_MIGRATION_OWNER_URL",
      ),
    });

    await expect(
      runCli(
        cwd,
        ["registry", "reindex-discovery", "--max-releases", "0"],
        undefined,
        {
          PITLORE_REGISTRY_DATABASE_URL: "",
          PITLORE_REGISTRY_DATABASE_HOST: "",
          PITLORE_REGISTRY_DATABASE_NAME: "",
          PITLORE_REGISTRY_DATABASE_USER: "",
          PITLORE_REGISTRY_DATABASE_PASSWORD: "",
          PITLORE_REGISTRY_DATABASE_PASSWORD_FILE: "",
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Registry discovery reindex max releases must be an integer between 1 and 100000",
      ),
    });

    await expect(
      runCli(
        cwd,
        [
          "registry",
          "reindex-discovery",
          "--database-url-env",
          "PITLORE_MIGRATION_OWNER_URL",
          "--max-releases",
          "1",
        ],
        undefined,
        {
          PITLORE_MIGRATION_OWNER_URL: "https://not-postgresql.example.com/db",
          PITLORE_REGISTRY_DATABASE_URL:
            "postgresql://default:secret@127.0.0.1:1/pitlore",
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Registry database URL must use postgres or postgresql",
      ),
    });

    for (const invalidCount of ["01", "100001", "1.5", "not-a-number"]) {
      await expect(
        runCli(
          cwd,
          [
            "registry",
            "reindex-discovery",
            "--database-url-env",
            "PITLORE_MIGRATION_OWNER_URL",
            "--max-releases",
            invalidCount,
          ],
          undefined,
          {
            PITLORE_MIGRATION_OWNER_URL:
              "postgresql://owner:secret@127.0.0.1:1/pitlore",
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Registry discovery reindex max releases must be an integer between 1 and 100000",
        ),
      });
    }
  }, 30_000);
});

function runCli(
  cwd: string,
  args: string[],
  bearer?: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return execute(pitloreCliCommand, pitloreCliArgs(...args), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PITLORE_LORE: "",
      PITLORE_REGISTRY_TOKEN: bearer ?? "",
      ...extraEnvironment,
    },
  });
}

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makePack(name: string, version: string): string {
  const root = makeRoot("pitlore-registry-cli-pack-");
  fs.cpSync(
    fileURLToPath(new URL("../packs/node-reliability", import.meta.url)),
    root,
    { recursive: true },
  );
  const manifest = path.join(root, "manifest.yaml");
  fs.writeFileSync(
    manifest,
    fs
      .readFileSync(manifest, "utf8")
      .replace("name: pitlore/node-reliability", `name: ${name}`)
      .replace("version: 0.1.0", `version: ${version}`),
    "utf8",
  );
  return root;
}

function user(domain: RegistryDomainService, name: string): RegistryUser {
  return domain.registerUser({ email: `${name}@example.com`, display_name: name });
}

function actor(
  identity: RegistryUser,
  organization: RegistryOrganization,
  role: "publisher" | "admin" | "owner",
): RegistryActor {
  return createHumanActor(
    {
      provider: "test",
      issuer: "https://identity.example.com/",
      providerSubjectId: identity.id,
      subjectId: identity.id,
      tenantId: organization.id,
      verifiedAt: NOW,
    },
    role,
  );
}
