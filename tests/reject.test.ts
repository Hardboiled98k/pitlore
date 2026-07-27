import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkContent } from "../src/check.js";
import { recordEvidence } from "../src/evidence.js";
import { exportAgentsSnippet, exportPromptFromRanked } from "../src/export.js";
import { createMcpServer } from "../src/mcp-server.js";
import { formatLessonsForPrompt, rankLessons } from "../src/retrieve.js";
import {
  buildReviewPacket,
  buildReviewQueue,
  recordCandidateReview,
} from "../src/review.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import {
  approvedCatalogHash,
  approveLesson,
  deprecateLesson,
  getApprovalReadiness,
  getLesson,
  initLore,
  listLessons,
  loadReviewStore,
  loadStore,
  putLesson,
  rejectLesson,
} from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("human rejection lifecycle", () => {
  it("persists a candidate as an idempotent rejected tombstone", () => {
    const root = makeLoreRoot();
    putLesson(root, candidate("reject-persists-tombstone"));

    const rejected = rejectLesson(root, "reject-persists-tombstone");
    const repeated = rejectLesson(root, "reject-persists-tombstone");

    expect(rejected.status).toBe("rejected");
    expect(repeated).toEqual(rejected);
    expect(getLesson(loadStore(root), rejected.id)).toEqual(rejected);
    expect(fs.readFileSync(path.join(root, "lessons", `${rejected.id}.yaml`), "utf8"))
      .toContain("status: rejected");
    expect(getApprovalReadiness(root, rejected.id)).toEqual({
      ready: false,
      issues: [`Rejected lesson cannot be approved: ${rejected.id}`],
    });
  });

  it("closes direct-write and terminal-state transition bypasses", () => {
    const root = makeLoreRoot();
    const forged = validateLesson({
      ...candidate("direct-rejected-write"),
      status: "rejected",
    });
    expect(() => putLesson(root, forged)).toThrow(
      "Refusing to write rejected lesson directly; use rejectLesson",
    );
    const forgedDeprecated = validateLesson({
      ...candidate("direct-deprecated-write"),
      status: "deprecated",
    });
    expect(() => putLesson(root, forgedDeprecated)).toThrow(
      "Refusing to write deprecated lesson directly; use deprecateLesson",
    );

    const rejectedCandidate = candidate("rejected-cannot-revive");
    putLesson(root, rejectedCandidate);
    rejectLesson(root, rejectedCandidate.id);
    expect(() =>
      putLesson(root, rejectedCandidate, { overwrite: true }),
    ).toThrow("Cannot overwrite rejected lesson through putLesson");
    expect(() => approveLesson(root, rejectedCandidate.id)).toThrow(
      `Rejected lesson cannot be approved: ${rejectedCandidate.id}`,
    );

    const approvedCandidate = candidate("approved-cannot-reject");
    putLesson(root, approvedCandidate);
    approveLesson(root, approvedCandidate.id);
    expect(() => rejectLesson(root, approvedCandidate.id)).toThrow(
      `Approved lesson cannot be rejected: ${approvedCandidate.id}`,
    );
    expect(() =>
      putLesson(root, approvedCandidate, { overwrite: true }),
    ).toThrow("Cannot overwrite approved lesson through putLesson");

    const deprecated = validateLesson({
      ...candidate("deprecated-cannot-reject"),
      status: "deprecated",
    });
    fs.writeFileSync(
      path.join(root, "lessons", `${deprecated.id}.yaml`),
      JSON.stringify(deprecated),
      "utf8",
    );
    expect(() => rejectLesson(root, deprecated.id)).toThrow(
      `Deprecated lesson cannot be rejected: ${deprecated.id}`,
    );
    expect(() =>
      putLesson(root, candidate(deprecated.id), { overwrite: true }),
    ).toThrow("Cannot overwrite deprecated lesson through putLesson");
    expect(() => rejectLesson(root, "missing-reject-target")).toThrow(
      "Lesson not found: missing-reject-target",
    );
  });

  it("preserves file permissions across transitions and umask changes", () => {
    if (process.platform === "win32") return;
    const root = makeLoreRoot();
    for (const [id, transition] of [
      ["private-mode-on-approve", approveLesson],
      ["private-mode-on-reject", rejectLesson],
    ] as const) {
      putLesson(root, candidate(id));
      const file = path.join(root, "lessons", `${id}.yaml`);
      fs.chmodSync(file, 0o600);

      transition(root, id);

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }

    const id = "mode-survives-umask-change";
    putLesson(root, candidate(id));
    const file = path.join(root, "lessons", `${id}.yaml`);
    fs.chmodSync(file, 0o644);
    const previousUmask = process.umask(0o077);
    try {
      approveLesson(root, id);
    } finally {
      process.umask(previousUmask);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it("supports the maximum portable id length during atomic transitions", () => {
    const root = makeLoreRoot();
    const id = "a".repeat(128);
    putLesson(root, candidate(id));

    expect(rejectLesson(root, id).status).toBe("rejected");
    expect(
      fs.readdirSync(path.join(root, "lessons")).some((name) =>
        name.includes("pitlore-write"),
      ),
    ).toBe(false);
  });

  it("preserves an existing .yml lesson filename during transitions", () => {
    const root = makeLoreRoot();
    const lesson = candidate("transition-keeps-yml-extension");
    const yml = path.join(root, "lessons", `${lesson.id}.yml`);
    fs.writeFileSync(yml, JSON.stringify(lesson), "utf8");

    expect(approveLesson(root, lesson.id).status).toBe("approved");
    expect(fs.existsSync(yml)).toBe(true);
    expect(
      fs.existsSync(path.join(root, "lessons", `${lesson.id}.yaml`)),
    ).toBe(false);
    expect(fs.readFileSync(yml, "utf8")).toContain("status: approved");
  });

  it("deprecates only approved lessons and keeps the transition idempotent", () => {
    const root = makeLoreRoot();
    const id = "approved-then-deprecated";
    putLesson(root, candidate(id));
    expect(() => deprecateLesson(root, id)).toThrow(
      "Candidate lesson cannot be deprecated",
    );
    approveLesson(root, id);
    const approvedHash = approvedCatalogHash(loadStore(root));

    const deprecated = deprecateLesson(root, id);
    expect(deprecated.status).toBe("deprecated");
    expect(deprecateLesson(root, id)).toEqual(deprecated);
    expect(approvedCatalogHash(loadStore(root))).not.toBe(approvedHash);
    expect(() => approveLesson(root, id)).toThrow(
      `Deprecated lesson cannot be approved: ${id}`,
    );
    expect(() => rejectLesson(root, id)).toThrow(
      `Deprecated lesson cannot be rejected: ${id}`,
    );

    const rejectedId = "rejected-cannot-deprecate";
    putLesson(root, candidate(rejectedId));
    rejectLesson(root, rejectedId);
    expect(() => deprecateLesson(root, rejectedId)).toThrow(
      `Rejected lesson cannot be deprecated: ${rejectedId}`,
    );
  });

  it("never consumes rejected lessons while keeping explicit audit access", () => {
    const root = makeLoreRoot();
    const lesson = candidate("rejected-never-consumed", {
      enforcement: {
        patterns: ["("],
        fixtures: { bad: [], good: [] },
      },
    });
    putLesson(root, lesson);
    const rejected = rejectLesson(root, lesson.id);
    const store = loadStore(root);

    expect(
      rankLessons(store, {
        intent: "dangerous call rejection governance",
        includeCandidate: true,
      }),
    ).toEqual([]);
    expect(checkContent(store, "dangerousCall();", { onlyApproved: false }))
      .toEqual({ findings: [], configurationErrors: [], clean: true });
    expect(exportAgentsSnippet(store.lessons)).not.toContain(rejected.id);
    expect(
      exportPromptFromRanked([
        { lesson: rejected, score: 10, reasons: ["forged-input"] },
      ]),
    ).toBe("No PitLore lessons matched this context.");
    expect(
      formatLessonsForPrompt([
        { lesson: rejected, score: 10, reasons: ["forged-public-input"] },
      ]),
    ).toBe("No PitLore lessons matched this context.");
    expect(listLessons(store, { status: "rejected" })).toEqual([rejected]);
    expect(getLesson(store, rejected.id)).toEqual(rejected);
    expect(() =>
      recordEvidence(root, {
        type: "detector_observation",
        observation_id: "rejected-detector-evidence",
        task_id: "rejected-lifecycle-test",
        client: "vitest",
        sample_kind: "fixture",
        observed_catalog_hash: approvedCatalogHash(store),
        lesson_id: rejected.id,
        target: "src/rejected.ts",
        classification: "tp",
        gate_pressure: false,
        reason: "Rejected lessons cannot be recorded as approved detector evidence",
      }),
    ).toThrow("detector observation must reference a currently approved lesson");
  });

  it("never consumes deprecated lessons while keeping explicit audit access", () => {
    const root = makeLoreRoot();
    const lesson = candidate("deprecated-never-consumed");
    putLesson(root, lesson);
    recordReview(root, lesson.id, "accept");
    approveLesson(root, lesson.id);
    const deprecated = deprecateLesson(root, lesson.id);
    const store = loadStore(root);

    expect(
      rankLessons(store, {
        intent: "dangerous call deprecation governance",
        includeCandidate: true,
      }),
    ).toEqual([]);
    expect(checkContent(store, "dangerousCall();", { onlyApproved: false }))
      .toEqual({ findings: [], configurationErrors: [], clean: true });
    expect(exportAgentsSnippet(store.lessons)).not.toContain(deprecated.id);
    expect(
      exportPromptFromRanked([
        { lesson: deprecated, score: 10, reasons: ["forged-input"] },
      ]),
    ).toBe("No PitLore lessons matched this context.");
    expect(
      formatLessonsForPrompt([
        { lesson: deprecated, score: 10, reasons: ["forged-public-input"] },
      ]),
    ).toBe("No PitLore lessons matched this context.");
    expect(listLessons(store, { status: "deprecated" })).toEqual([deprecated]);
    expect(getLesson(store, deprecated.id)).toEqual(deprecated);
    expect(buildReviewQueue(root).items).toEqual([]);
    expect(() => buildReviewPacket(root, deprecated.id)).toThrow(
      `Only candidate lessons can be reviewed: ${deprecated.id}`,
    );
    expect(() =>
      recordEvidence(root, {
        type: "detector_observation",
        observation_id: "deprecated-detector-evidence",
        task_id: "deprecated-lifecycle-test",
        client: "vitest",
        sample_kind: "fixture",
        observed_catalog_hash: approvedCatalogHash(store),
        lesson_id: deprecated.id,
        target: "src/deprecated.ts",
        classification: "tp",
        gate_pressure: false,
        reason: "Deprecated lessons cannot be recorded as approved detector evidence",
      }),
    ).toThrow("detector observation must reference a currently approved lesson");
  });

  it("keeps LLM rejection advisory, review sidecars auditable, and other reviews current", () => {
    const root = makeLoreRoot();
    putLesson(root, candidate("advisory-reject-only"));
    putLesson(root, candidate("unrelated-current-review"));
    recordReview(root, "advisory-reject-only", "reject");
    recordReview(root, "unrelated-current-review", "accept");

    expect(getLesson(loadStore(root), "advisory-reject-only")?.status).toBe(
      "candidate",
    );
    const catalogBefore = approvedCatalogHash(loadStore(root));
    rejectLesson(root, "advisory-reject-only");

    expect(approvedCatalogHash(loadStore(root))).toBe(catalogBefore);
    expect(loadReviewStore(root).reviews.map((review) => review.lesson_id).sort())
      .toEqual(["advisory-reject-only", "unrelated-current-review"]);
    expect(buildReviewQueue(root).items).toEqual([
      expect.objectContaining({
        id: "unrelated-current-review",
        state: "current",
        recommendation: "accept",
      }),
    ]);
  });

  it("exposes an idempotent explicit reject CLI transition", () => {
    const root = makeLoreRoot();
    putLesson(root, candidate("cli-human-reject"));
    const env = { ...process.env, PITLORE_LORE: root };

    const first = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("reject", "cli-human-reject"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    const firstYaml = fs.readFileSync(
      path.join(root, "lessons", "cli-human-reject.yaml"),
      "utf8",
    );
    const repeated = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("reject", "cli-human-reject"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    expect(first).toContain("Rejected cli-human-reject");
    expect(repeated).toContain("Rejected cli-human-reject");
    expect(
      fs.readFileSync(path.join(root, "lessons", "cli-human-reject.yaml"), "utf8"),
    ).toBe(firstYaml);
  }, 15_000);

  it("audits rejected lessons and reports an invalid CLI rejection", () => {
    const root = makeLoreRoot();
    putLesson(root, candidate("cli-human-reject"));
    rejectLesson(root, "cli-human-reject");
    const env = { ...process.env, PITLORE_LORE: root };

    const search = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("search", "cli", "--status", "rejected"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    const help = execFileSync(pitloreCliCommand, pitloreCliArgs("--help"), {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });

    const invalid = spawnSync(
      pitloreCliCommand,
      pitloreCliArgs("reject", "missing-cli-reject"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    expect(search).toContain("rejected");
    expect(search).toContain("cli-human-reject");
    expect(help).toContain("reject");
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Lesson not found: missing-cli-reject");
  }, 15_000);

  it("exposes deprecate and get through the CLI", () => {
    const root = makeLoreRoot();
    const env = { ...process.env, PITLORE_LORE: root };
    putLesson(root, candidate("cli-rejected-check-sentinel"));
    rejectLesson(root, "cli-rejected-check-sentinel");
    putLesson(root, candidate("cli-approved-then-deprecated"));
    approveLesson(root, "cli-approved-then-deprecated");

    const deprecated = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("deprecate", "cli-approved-then-deprecated"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    const deprecatedGet = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("get", "cli-approved-then-deprecated"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    expect(deprecated).toContain("Deprecated cli-approved-then-deprecated");
    expect(deprecatedGet).toContain('"status": "deprecated"');
  }, 15_000);

  it("searches deprecated lessons while check --all excludes terminal states", () => {
    const root = makeLoreRoot();
    const env = { ...process.env, PITLORE_LORE: root };
    putLesson(root, candidate("cli-rejected-check-sentinel"));
    rejectLesson(root, "cli-rejected-check-sentinel");
    putLesson(root, candidate("cli-approved-then-deprecated"));
    approveLesson(root, "cli-approved-then-deprecated");
    deprecateLesson(root, "cli-approved-then-deprecated");

    const deprecatedSearch = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("search", "cli", "--status", "deprecated"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    const source = path.join(root, "terminal-source.ts");
    fs.writeFileSync(source, "dangerousCall();\n", "utf8");
    const checkAll = spawnSync(
      pitloreCliCommand,
      pitloreCliArgs("check", source, "--all"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );

    expect(deprecatedSearch).toContain("cli-approved-then-deprecated");
    expect(checkAll.status).toBe(0);
    expect(checkAll.stdout).toContain("No PitLore findings");
  }, 15_000);

  it("keeps lifecycle transitions out of MCP while allowing terminal-state inspection", async () => {
    const root = makeLoreRoot();
    putLesson(root, candidate("mcp-inspects-rejected"));
    rejectLesson(root, "mcp-inspects-rejected");
    putLesson(root, candidate("mcp-inspects-deprecated"));
    approveLesson(root, "mcp-inspects-deprecated");
    deprecateLesson(root, "mcp-inspects-deprecated");
    const server = createMcpServer(root, root);
    const client = new Client({ name: "reject-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).not.toContain("pitlore_approve");
      expect(names).not.toContain("pitlore_reject");
      expect(names).not.toContain("pitlore_deprecate");

      const search = await client.callTool({
        name: "pitlore_search",
        arguments: { query: "mcp", status: "rejected" },
      });
      const get = await client.callTool({
        name: "pitlore_get",
        arguments: { id: "mcp-inspects-rejected" },
      });
      const deprecatedSearch = await client.callTool({
        name: "pitlore_search",
        arguments: { query: "mcp", status: "deprecated" },
      });
      const deprecatedGet = await client.callTool({
        name: "pitlore_get",
        arguments: { id: "mcp-inspects-deprecated" },
      });
      const retrieve = await client.callTool({
        name: "pitlore_retrieve",
        arguments: { intent: "mcp inspects rejected" },
      });
      const checked = await client.callTool({
        name: "pitlore_check",
        arguments: { content: "dangerousCall();" },
      });
      const exported = await client.callTool({
        name: "pitlore_export_prompt",
        arguments: { intent: "mcp inspects rejected" },
      });

      expect(JSON.stringify(search.content)).toContain("mcp-inspects-rejected");
      const fullLesson = JSON.parse(
        (get.content[0] as { type: "text"; text: string }).text,
      ) as Lesson;
      expect(fullLesson.status).toBe("rejected");
      expect(JSON.stringify(deprecatedSearch.content)).toContain(
        "mcp-inspects-deprecated",
      );
      const fullDeprecated = JSON.parse(
        (deprecatedGet.content[0] as { type: "text"; text: string }).text,
      ) as Lesson;
      expect(fullDeprecated.status).toBe("deprecated");
      expect(JSON.stringify(retrieve.content)).not.toContain(
        "mcp-inspects-rejected",
      );
      expect(JSON.stringify(retrieve.content)).not.toContain(
        "mcp-inspects-deprecated",
      );
      expect(JSON.stringify(checked.content)).not.toContain(
        "mcp-inspects-rejected",
      );
      expect(JSON.stringify(checked.content)).not.toContain(
        "mcp-inspects-deprecated",
      );
      expect(JSON.stringify(exported.content)).not.toContain(
        "mcp-inspects-rejected",
      );
      expect(JSON.stringify(exported.content)).not.toContain(
        "mcp-inspects-deprecated",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses external lesson symlinks and serializes writes with a lock", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-reject-outside-");
    putLesson(root, candidate("external-directory-target"));
    const lessons = path.join(root, "lessons");
    const outsideLessons = path.join(outside, "lessons");
    fs.renameSync(lessons, outsideLessons);
    fs.symlinkSync(outsideLessons, lessons, "dir");
    const outsideFile = path.join(
      outsideLessons,
      "external-directory-target.yaml",
    );
    const before = fs.readFileSync(outsideFile, "utf8");

    expect(() => rejectLesson(root, "external-directory-target")).toThrow(
      "Lessons directory must not be a symlink",
    );
    expect(fs.readFileSync(outsideFile, "utf8")).toBe(before);

    fs.unlinkSync(lessons);
    fs.renameSync(outsideLessons, lessons);
    const lock = lessonLockPath(lessons, "external-directory-target");
    fs.writeFileSync(lock, "held");
    expect(() => rejectLesson(root, "external-directory-target")).toThrow(
      "Lesson write already in progress",
    );
    expect(getLesson(loadStore(root), "external-directory-target")?.status).toBe(
      "candidate",
    );
    fs.unlinkSync(lock);
  });

  it("never auto-removes a stale-looking lock", () => {
    const root = makeLoreRoot();
    const id = "recover-dead-process-lock";
    putLesson(root, candidate(id));
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.pid).toBeTypeOf("number");
    const lock = lessonLockPath(path.join(root, "lessons"), id);
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: exited.pid,
        started_at: new Date(Date.now() - 60_000).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    expect(() => rejectLesson(root, id)).toThrow(
      "PitLore never auto-removes locks",
    );
    expect(fs.existsSync(lock)).toBe(true);
    expect(getLesson(loadStore(root), id)?.status).toBe("candidate");
  });

  it("does not unlink a replacement lock during cleanup", () => {
    const root = makeLoreRoot();
    const id = "preserve-replacement-lock";
    putLesson(root, candidate(id));
    const lessons = path.join(root, "lessons");
    const lock = lessonLockPath(lessons, id);
    const movedLock = `${lock}.original`;
    const originalLstat = fs.lstatSync.bind(fs);
    let lockStats = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((filePath, options) => {
      if (path.resolve(String(filePath)) === path.resolve(lock)) {
        lockStats += 1;
        if (lockStats === 2) {
          fs.renameSync(lock, movedLock);
          fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
            encoding: "utf8",
            mode: 0o600,
          });
        }
      }
      return originalLstat(filePath, options as never);
    }) as typeof fs.lstatSync);

    expect(() => rejectLesson(root, id)).toThrow(
      "write may have completed but lock cleanup failed",
    );
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toContain(`"pid":${process.pid}`);
    expect(getLesson(loadStore(root), id)?.status).toBe("rejected");
  });

  it("keeps lock cleanup failure context when the lifecycle operation also fails", () => {
    const root = makeLoreRoot();
    const id = "primary-and-cleanup-failure";
    putLesson(root, candidate(id));
    approveLesson(root, id);
    const lock = lessonLockPath(path.join(root, "lessons"), id);
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(lock)) {
        const error = new Error("simulated lock cleanup failure");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return originalUnlink(filePath);
    });

    expect(() => rejectLesson(root, id)).toThrow(
      /Approved lesson cannot be rejected.*lock cleanup also failed.*simulated lock cleanup failure/,
    );
    expect(fs.existsSync(lock)).toBe(true);
    expect(getLesson(loadStore(root), id)?.status).toBe("approved");
  });

  it("does not read a lesson-file symlink outside the lore root", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-reject-file-outside-");
    const lesson = candidate("external-file-target");
    const outsideFile = path.join(outside, "external-file-target.yaml");
    fs.writeFileSync(outsideFile, JSON.stringify(lesson), "utf8");
    fs.symlinkSync(
      outsideFile,
      path.join(root, "lessons", "external-file-target.yaml"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = loadStore(root);
    expect(getLesson(store, lesson.id)).toBeUndefined();
    expect(store.loadErrors).toEqual([
      expect.objectContaining({
        message: "lesson file must not be a symlink",
      }),
    ]);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe(JSON.stringify(lesson));
  });
});

function lessonLockPath(lessonsDir: string, id: string): string {
  const hash = createHash("sha256").update(id).digest("hex");
  return path.join(lessonsDir, `.pitlore-lock-${hash}.lock`);
}

function makeLoreRoot(): string {
  const root = makeTempRoot("pitlore-reject-");
  initLore(root);
  return root;
}

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function candidate(id: string, overrides: Partial<Lesson> = {}): Lesson {
  return validateLesson({
    id,
    title: "Human rejection remains an explicit decision",
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "governance",
    symptom: "An unsuitable candidate could remain in the active review queue",
    root_cause: "The lifecycle had approval but no explicit rejection state",
    forbid_pattern_abstract: "Treating an advisory rejection as authorization",
    safe_pattern_abstract:
      "Require an explicit human reject action and retain a non-consumable tombstone",
    enforcement: {
      patterns: ["dangerousCall\\s*\\("],
      fixtures: { bad: [], good: [] },
    },
    status: "candidate",
    visibility: "private",
    tags: ["rejection", "governance"],
    ...overrides,
  });
}

function recordReview(
  root: string,
  id: string,
  recommendation: "accept" | "edit" | "reject",
): void {
  const packet = buildReviewPacket(root, id);
  recordCandidateReview(
    root,
    id,
    {
      recommendation,
      confidence: 0.9,
      summary: "Advisory review only; a separate lifecycle action is required.",
      strengths: ["The trust boundary is explicit."],
      risks: [],
      required_changes: [],
      reviewer: { provider: "test", model: "independent-reviewer" },
    },
    packet.review_context_hash,
  );
}
