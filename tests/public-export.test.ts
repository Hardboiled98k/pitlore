import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeLessonForPublic } from "../src/public-export.js";
import {
  approveLesson,
  initLore,
  putLesson,
} from "../src/store.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const roots: string[] = [];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return validateLesson({
    id: "public-export-test",
    version: "0.1.0",
    title: "Keep request deadlines bounded",
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "reliability",
    symptom: "Requests can hang during network failure",
    root_cause: "The client had no overall deadline",
    forbid_pattern_abstract: "Calling fetch without an AbortSignal",
    safe_pattern_abstract: "Use AbortSignal.timeout for a bounded request",
    scope: { paths: ["/Users/private/project/src"] },
    severity: "warn",
    confidence: 0.9,
    sources: {
      count: 2,
      references: ["/Users/private/project/bug.md", "https://example.com/lesson"],
    },
    enforcement: { test_idea: "Mock a hung server and assert a deadline", patterns: [] },
    tags: ["http"],
    status: "approved",
    visibility: "private",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  });
}

describe("Phase 2 public Lesson export", () => {
  it("exports only approved content and strips local scope and non-URL sources", () => {
    const draft = sanitizeLessonForPublic(lesson());
    expect(draft.visibility).toBe("public");
    expect(draft.status).toBe("approved");
    expect(draft.scope).toEqual({ paths: [] });
    expect(draft.sources).toEqual({
      count: 1,
      references: ["https://example.com/lesson"],
    });
  });

  it("fails closed for candidates and unsafe public content", () => {
    expect(() => sanitizeLessonForPublic(lesson({ status: "candidate" }))).toThrow(
      "Only approved lessons can be exported publicly",
    );
    expect(() =>
      sanitizeLessonForPublic(
        lesson({ symptom: "The request includes an api_key: field" }),
      ),
    ).toThrow("Public export blocked");
  });

  it("exposes explicit public export through the CLI", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-public-export-"));
    roots.push(root);
    initLore(root, { copySeed: false });
    const candidate = lesson({ id: "cli-public-export", status: "candidate" });
    putLesson(root, candidate);
    approveLesson(root, candidate.id);
    const output = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("export-public", candidate.id),
      {
        cwd: repoRoot,
        env: { ...process.env, PITLORE_LORE: root },
        encoding: "utf8",
      },
    );
    const exported = yaml.load(output) as Record<string, unknown>;
    expect(exported.visibility).toBe("public");
    expect(exported.status).toBe("approved");
    expect(exported.scope).toEqual({ paths: [] });
  });
});
