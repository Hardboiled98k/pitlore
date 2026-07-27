import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkContent } from "../src/check.js";
import { createMcpServer } from "../src/mcp-server.js";
import { resolveLoreRoot } from "../src/paths.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import {
  approvedCatalogHash,
  approveLesson,
  ensureWritableLoreRoot,
  getLesson,
  initLore,
  loadStore,
  putLesson,
} from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const seed = path.join(repoRoot, "seed");
const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("writable lore root", () => {
  it("keeps bundled seed readable but redirects direct store writes", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    const lesson = makeLesson("direct-write-does-not-touch-seed");
    let createCount = 0;

    expect(loadStore(seed).lessons.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(seed, "lessons", `${lesson.id}.yaml`))).toBe(
      false,
    );

    const resolved = ensureWritableLoreRoot(seed, {
      cwd,
      onCreate: () => createCount++,
    });
    const resolvedAgain = ensureWritableLoreRoot(seed, {
      cwd,
      onCreate: () => createCount++,
    });
    const saved = putLesson(seed, lesson, { cwd });

    expect(resolved).toBe(localRoot);
    expect(resolvedAgain).toBe(localRoot);
    expect(createCount).toBe(1);
    expect(saved).toBe(path.join(localRoot, "lessons", `${lesson.id}.yaml`));
    expect(fs.existsSync(path.join(localRoot, "manifest.yaml"))).toBe(true);
    expect(getLesson(loadStore(localRoot), lesson.id)?.status).toBe("candidate");
    expect(fs.existsSync(path.join(seed, "lessons", `${lesson.id}.yaml`))).toBe(
      false,
    );
    expect(() => putLesson(seed, lesson, { cwd })).toThrow(
      `Lesson already exists: ${lesson.id}`,
    );

    approveLesson(seed, lesson.id, { cwd });
    expect(getLesson(loadStore(localRoot), lesson.id)?.status).toBe("approved");
    expect(fs.existsSync(path.join(seed, "lessons", `${lesson.id}.yaml`))).toBe(
      false,
    );
  });

  it("does not silently ignore a configured lore path that is not initialized yet", () => {
    const cwd = makeTempRoot();
    const configuredRoot = path.join(cwd, "configured-lore");
    vi.stubEnv("PITLORE_LORE", configuredRoot);

    expect(resolveLoreRoot(cwd)).toBe(configuredRoot);
    expect(() => loadStore()).toThrow(`No lore found at ${configuredRoot}`);

    expect(ensureWritableLoreRoot(undefined, { cwd })).toBe(configuredRoot);
    expect(fs.existsSync(path.join(configuredRoot, "manifest.yaml"))).toBe(true);
  });

  it("rejects unsafe public lessons before writing", () => {
    const cwd = makeTempRoot();
    const unsafe = validateLesson({
      ...makeLesson("unsafe-public-lesson"),
      visibility: "public",
      symptom: `The config exposed ${["api", "key"].join("_")}=${[
        "sk",
        "test-secret-value",
      ].join("-")}`,
    });

    expect(() => putLesson(seed, unsafe, { cwd })).toThrow(
      "Refusing to write unsafe public lesson",
    );
    expect(fs.existsSync(path.join(cwd, ".pitlore"))).toBe(false);
    expect(
      fs.existsSync(path.join(seed, "lessons", `${unsafe.id}.yaml`)),
    ).toBe(false);
  });

  it("keeps invalid lesson files visible to the enforcement gate", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    initLore(localRoot);
    fs.writeFileSync(
      path.join(localRoot, "lessons", "broken.yaml"),
      "id: broken\ntitle: missing-required-fields\n",
      "utf8",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = loadStore(localRoot);
    const result = checkContent(store, "const safe = true;");

    expect(store.loadErrors).toEqual([
      expect.objectContaining({
        filePath: path.join(localRoot, "lessons", "broken.yaml"),
      }),
    ]);
    expect(result.clean).toBe(false);
    expect(result.configurationErrors).toEqual([
      expect.objectContaining({ kind: "invalid-lesson" }),
    ]);
  });

  it("rejects manually added unsafe public lessons while loading", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    const unsafe = validateLesson({
      ...makeLesson("manual-public-secret"),
      visibility: "public",
      symptom: `Leaked ${[
        "ghp",
        "abcdefghijklmnopqrstuvwxyz123456",
      ].join("_")}`,
    });
    initLore(localRoot);
    fs.writeFileSync(
      path.join(localRoot, "lessons", `${unsafe.id}.yaml`),
      JSON.stringify(unsafe),
      "utf8",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = loadStore(localRoot);
    const result = checkContent(store, "const safe = true;");

    expect(getLesson(store, unsafe.id)).toBeUndefined();
    expect(store.loadErrors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("unsafe public lesson"),
      }),
    ]);
    expect(result.clean).toBe(false);
  });

  it("reports duplicate lesson ids from hand-edited or merged lore", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    const duplicate = makeLesson("duplicate-load-id");
    initLore(localRoot);
    for (const extension of ["yaml", "yml"]) {
      fs.writeFileSync(
        path.join(localRoot, "lessons", `${duplicate.id}.${extension}`),
        JSON.stringify(duplicate),
        "utf8",
      );
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = loadStore(localRoot);

    expect(
      store.lessons.filter((lesson) => lesson.id === duplicate.id),
    ).toHaveLength(1);
    expect(store.loadErrors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("duplicate lesson id"),
      }),
    ]);
  });

  it("does not revive a deprecated lesson through approve", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    initLore(localRoot);
    const deprecated = validateLesson({
      ...makeLesson("deprecated-stays-deprecated"),
      status: "deprecated",
    });
    fs.writeFileSync(
      path.join(localRoot, "lessons", `${deprecated.id}.yaml`),
      JSON.stringify(deprecated),
      "utf8",
    );

    expect(() => approveLesson(localRoot, deprecated.id)).toThrow(
      `Deprecated lesson cannot be approved: ${deprecated.id}`,
    );
    expect(getLesson(loadStore(localRoot), deprecated.id)?.status).toBe(
      "deprecated",
    );
  });

  it("rejects a nested lessons symlink that targets bundled seed", () => {
    const cwd = makeTempRoot();
    const localRoot = path.join(cwd, ".pitlore");
    const lesson = makeLesson("nested-symlink-does-not-touch-seed");
    initLore(localRoot);
    fs.rmSync(path.join(localRoot, "lessons"), { recursive: true });
    fs.symlinkSync(
      path.join(seed, "lessons"),
      path.join(localRoot, "lessons"),
      "dir",
    );

    expect(() => putLesson(localRoot, lesson)).toThrow(
      "Refusing to write lesson inside bundled seed",
    );
    expect(fs.existsSync(path.join(seed, "lessons", `${lesson.id}.yaml`))).toBe(
      false,
    );
  });

  it("uses the shared redirect for CLI add and preserves its first-write UX", () => {
    const cwd = makeTempRoot();
    const lesson = makeLesson("cli-write-does-not-touch-seed");
    const input = path.join(cwd, "lesson.json");
    fs.writeFileSync(input, JSON.stringify(lesson), "utf8");

    const output = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("add", input),
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PITLORE_LORE: seed },
      },
    );

    const localFile = path.join(
      fs.realpathSync.native(cwd),
      ".pitlore",
      "lessons",
      `${lesson.id}.yaml`,
    );
    const wroteLine = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith("Wrote "));
    expect(wroteLine).toBeDefined();
    const reportedFile = wroteLine!.slice("Wrote ".length);
    expect(fs.realpathSync.native(reportedFile)).toBe(
      fs.realpathSync.native(localFile),
    );
    expect(fs.existsSync(localFile)).toBe(true);
    expect(fs.existsSync(path.join(seed, "lessons", `${lesson.id}.yaml`))).toBe(
      false,
    );
  });

  it("moves MCP remember onto the project store as a candidate", async () => {
    const cwd = makeTempRoot();
    const lessonId = "mcp-write-does-not-touch-seed";
    vi.stubEnv("OPENAI_API_KEY", "");

    const server = createMcpServer("", cwd);
    const client = new Client({ name: "pitlore-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const remembered = await client.callTool({
        name: "pitlore_remember",
        arguments: {
          description: "MCP writes must never mutate bundled seed lessons",
          languages: ["typescript"],
          idHint: lessonId,
          // Legacy clients may still send this removed field. It must never
          // promote an agent-generated lesson past human review.
          approve: true,
        },
      });
      expect(remembered.isError).not.toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("pitlore_approve");
    } finally {
      await client.close();
      await server.close();
    }

    const localRoot = path.join(cwd, ".pitlore");
    expect(getLesson(loadStore(localRoot), lessonId)?.status).toBe("candidate");
    expect(fs.existsSync(path.join(seed, "lessons", `${lessonId}.yaml`))).toBe(
      false,
    );
  });

  it(
    "initializes an explicit MCP write root and reads the saved candidate",
    async () => {
      const cwd = makeTempRoot();
      const explicitRoot = path.join(cwd, "shared-lore");
      const lessonId = "mcp-explicit-root-round-trip";
      vi.stubEnv("OPENAI_API_KEY", "");

      const server = createMcpServer(explicitRoot, cwd);
      const client = new Client({ name: "pitlore-test", version: "0.1.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const remembered = await client.callTool({
          name: "pitlore_remember",
          arguments: {
            description: "An explicit MCP root must be initialized before writing",
            idHint: lessonId,
          },
        });
        expect(remembered.isError).not.toBe(true);

        const retrieved = await client.callTool({
          name: "pitlore_retrieve",
          arguments: {
            intent: "An explicit MCP root must be initialized before writing",
            // Legacy callers may request candidates, but the normal agent
            // retrieval path must stay approved-only.
            includeCandidate: true,
          },
        });
        expect(retrieved.isError).not.toBe(true);
        expect(JSON.stringify(retrieved.content)).toContain(
          "No PitLore lessons matched this context.",
        );
        expect(JSON.stringify(retrieved.content)).toContain(
          `observed_catalog_hash: ${approvedCatalogHash(loadStore(explicitRoot))}`,
        );
        expect(JSON.stringify(retrieved.content)).not.toContain(lessonId);

        const checked = await client.callTool({
          name: "pitlore_check",
          arguments: {
            content: "const safe = true;",
            filePath: "src/safe.ts",
          },
        });
        expect(checked.isError).not.toBe(true);
        expect(
          JSON.parse(
            (checked.content[0] as { type: "text"; text: string }).text,
          ),
        ).toMatchObject({
          observed_catalog_hash: approvedCatalogHash(loadStore(explicitRoot)),
          clean: true,
        });

        const loaded = await client.callTool({
          name: "pitlore_get",
          arguments: { id: lessonId },
        });
        expect(loaded.isError).not.toBe(true);
      } finally {
        await client.close();
        await server.close();
      }

      expect(fs.existsSync(path.join(explicitRoot, "manifest.yaml"))).toBe(true);
      expect(getLesson(loadStore(explicitRoot), lessonId)?.status).toBe(
        "candidate",
      );
    },
  );
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-writable-"));
  tempRoots.push(root);
  return root;
}

function makeLesson(id: string): Lesson {
  return validateLesson({
    id,
    title: "Never write bundled seed",
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "storage",
    symptom: "A write operation mutates package seed data",
    root_cause: "Read and write roots were resolved with the same fallback",
    forbid_pattern_abstract: "Writing to the bundled read-only seed directory",
    safe_pattern_abstract: "Create a project-local lore store before writing",
    status: "candidate",
    visibility: "private",
  });
}
