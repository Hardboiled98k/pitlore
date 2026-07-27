import { describe, expect, it } from "vitest";
import { checkContent, formatFindings } from "../src/check.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import type { LoreStore } from "../src/store.js";

function lesson(options: {
  id: string;
  paths?: string[];
  pattern?: string;
}): Lesson {
  return validateLesson({
    id: options.id,
    title: "Scoped detector",
    languages: ["typescript"],
    category: "quality",
    symptom: "Unsafe call detected",
    root_cause: "A repository rule was not followed",
    forbid_pattern_abstract: "Do not call unsafeCall",
    safe_pattern_abstract: "Call safeCall instead",
    scope: { paths: options.paths ?? [] },
    status: "approved",
    enforcement: {
      patterns: [options.pattern ?? "unsafeCall\\s*\\("],
    },
  });
}

function store(...lessons: Lesson[]): LoreStore {
  return {
    root: "/tmp/lore",
    manifest: {
      name: "test/lore",
      description: "",
      visibility: "private",
      version: "0.1.0",
      default_status_for_new: "candidate",
    },
    lessons,
    loadErrors: [],
  };
}

describe("checkContent lesson path scopes", () => {
  it("treats an empty path scope as global", () => {
    const result = checkContent(
      store(lesson({ id: "global-detector" })),
      "unsafeCall();",
      { filePath: "tests/unrelated.test.ts" },
    );

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it("runs a scoped lesson only for a matching file path", () => {
    const scoped = lesson({ id: "source-detector", paths: ["src/**/*.ts"] });

    const matching = checkContent(store(scoped), "unsafeCall();", {
      filePath: "src/services/account.ts",
    });
    const unrelated = checkContent(store(scoped), "unsafeCall();", {
      filePath: "tests/account.test.ts",
    });

    expect(matching.findings).toHaveLength(1);
    expect(unrelated.clean).toBe(true);
    expect(unrelated.findings).toHaveLength(0);
  });

  it("matches project-relative scopes when the caller supplies an absolute path", () => {
    const scoped = lesson({
      id: "absolute-path-detector",
      paths: ["src/**/*.ts"],
    });
    const result = checkContent(store(scoped), "unsafeCall();", {
      filePath: "/workspace/project/src/services/account.ts",
    });

    expect(result.findings).toHaveLength(1);
  });

  it("fails closed for a scoped lesson when filePath is unavailable", () => {
    const scoped = lesson({
      id: "missing-path-detector",
      paths: ["src/**/*.ts"],
    });
    const result = checkContent(store(scoped), "unsafeCall();");

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
  });
});

describe("checkContent detector configuration", () => {
  it("treats invalid lesson files as non-clean configuration errors", () => {
    const broken = store();
    broken.loadErrors.push({
      filePath: "/tmp/lore/lessons/broken.yaml",
      message: "Invalid lesson schema",
    });

    const result = checkContent(broken, "const safe = true;");

    expect(result.clean).toBe(false);
    expect(result.configurationErrors).toContainEqual({
      kind: "invalid-lesson",
      filePath: "/tmp/lore/lessons/broken.yaml",
      message: "Invalid lesson schema",
    });
    expect(formatFindings(result)).toContain("Invalid lesson");
  });

  it("reports an invalid detector regex and never returns clean", () => {
    const invalid = lesson({
      id: "invalid-regex-detector",
      pattern: "[unterminated",
    });
    const result = checkContent(store(invalid), "const safe = true;");

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.configurationErrors).toEqual([
      expect.objectContaining({
        kind: "invalid-detector-regex",
        lessonId: "invalid-regex-detector",
        pattern: "[unterminated",
      }),
    ]);
    expect(formatFindings(result)).toContain("Invalid detector regex");
  });

  it("reports invalid scoped detectors even for an unrelated file", () => {
    const invalid = lesson({
      id: "invalid-scoped-regex",
      paths: ["src/**/*.ts"],
      pattern: "[unterminated",
    });
    const result = checkContent(store(invalid), "const safe = true;", {
      filePath: "tests/example.ts",
    });

    expect(result.clean).toBe(false);
    expect(result.configurationErrors).toEqual([
      expect.objectContaining({
        kind: "invalid-detector-regex",
        lessonId: "invalid-scoped-regex",
      }),
    ]);
  });
});
