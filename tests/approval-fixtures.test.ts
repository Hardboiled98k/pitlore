import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLesson, type Lesson } from "../src/schema.js";
import {
  approveLesson,
  getLesson,
  initLore,
  loadStore,
  putLesson,
} from "../src/store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("block lesson approval fixtures", () => {
  it("approves a block lesson only after every bad and good fixture passes", () => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad/one.ts", "unsafeCall();");
    writeFixture(root, "fixtures/bad/two.ts", "const x = unsafeCall();");
    writeFixture(root, "fixtures/good/one.ts", "safeCall();");
    writeFixture(root, "fixtures/good/two.ts", "const safe = true;");
    const lesson = makeBlockLesson("fixture-gate-passes", {
      bad: ["fixtures/bad/one.ts", "fixtures/bad/two.ts"],
      good: ["fixtures/good/one.ts", "fixtures/good/two.ts"],
    });
    putLesson(root, lesson);

    expect(approveLesson(root, lesson.id).status).toBe("approved");
    expect(getLesson(loadStore(root), lesson.id)?.status).toBe("approved");
  });

  it("keeps non-block approvals compatible without fixtures", () => {
    const root = makeLore();
    const lesson = validateLesson({
      ...baseLesson("warn-needs-no-fixtures"),
      severity: "warn",
    });
    putLesson(root, lesson);

    expect(approveLesson(root, lesson.id).status).toBe("approved");
  });

  it("rejects invalid detector regex for non-block lessons", () => {
    const root = makeLore();
    const lesson = validateLesson({
      ...baseLesson("warn-invalid-regex"),
      severity: "warn",
      enforcement: { patterns: ["[unterminated"] },
    });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "invalid detector configuration",
    );
    expectCandidate(root, lesson.id);
  });

  it("rejects detector regexes with catastrophic backtracking risk", () => {
    const root = makeLore();
    const lesson = validateLesson({
      ...baseLesson("warn-unsafe-regex"),
      severity: "warn",
      enforcement: { patterns: ["(a+)+$"] },
    });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "invalid detector configuration",
    );
    expectCandidate(root, lesson.id);
  });

  it("rejects direct approved writes while keeping approve as the only transition", () => {
    const root = makeLore();
    const candidate = validateLesson({
      ...baseLesson("approved-write-needs-gate"),
      severity: "warn",
    });
    const approved = validateLesson({ ...candidate, status: "approved" });

    expect(() => putLesson(root, approved)).toThrow(
      "Refusing to write approved lesson directly; use approveLesson",
    );
    expect(getLesson(loadStore(root), approved.id)).toBeUndefined();

    putLesson(root, candidate);
    expect(() => putLesson(root, approved, { overwrite: true })).toThrow(
      "Refusing to write approved lesson directly; use approveLesson",
    );
    expectCandidate(root, candidate.id);
    expect(approveLesson(root, candidate.id).status).toBe("approved");
  });

  it("keeps repeated approval idempotent for legacy approved block lessons", () => {
    const root = makeLore();
    const legacy = validateLesson({
      ...baseLesson("legacy-approved-block"),
      severity: "block",
      status: "approved",
      enforcement: { patterns: ["unsafeCall\\s*\\("] },
    });
    fs.writeFileSync(
      path.join(root, "lessons", `${legacy.id}.yaml`),
      JSON.stringify(legacy),
      "utf8",
    );

    expect(legacy.enforcement.fixtures).toEqual({ bad: [], good: [] });
    expect(approveLesson(root, legacy.id)).toEqual(legacy);
  });

  it("rejects block approval without declarative patterns", () => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad.ts", "unsafeCall();");
    writeFixture(root, "fixtures/good.ts", "safeCall();");
    const lesson = makeBlockLesson(
      "block-needs-patterns",
      { bad: ["fixtures/bad.ts"], good: ["fixtures/good.ts"] },
      [],
    );
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "at least one non-empty declarative pattern is required",
    );
    expectCandidate(root, lesson.id);
  });

  it.each([
    ["bad", [], ["fixtures/good.ts"]],
    ["good", ["fixtures/bad.ts"], []],
  ])("rejects block approval without a %s fixture", (_kind, bad, good) => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad.ts", "unsafeCall();");
    writeFixture(root, "fixtures/good.ts", "safeCall();");
    const lesson = makeBlockLesson("block-needs-both-fixtures", { bad, good });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "at least one bad and one good fixture are required",
    );
    expectCandidate(root, lesson.id);
  });

  it("fails closed on invalid detector regex", () => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad.ts", "unsafeCall();");
    writeFixture(root, "fixtures/good.ts", "safeCall();");
    const lesson = makeBlockLesson(
      "block-invalid-regex",
      { bad: ["fixtures/bad.ts"], good: ["fixtures/good.ts"] },
      ["[unterminated"],
    );
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "invalid detector configuration",
    );
    expectCandidate(root, lesson.id);
  });

  it("checks every bad fixture for a detector hit", () => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad/hit.ts", "unsafeCall();");
    writeFixture(root, "fixtures/bad/miss.ts", "safeCall();");
    writeFixture(root, "fixtures/good.ts", "safeCall();");
    const lesson = makeBlockLesson("every-bad-must-hit", {
      bad: ["fixtures/bad/hit.ts", "fixtures/bad/miss.ts"],
      good: ["fixtures/good.ts"],
    });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "bad fixture was not detected: fixtures/bad/miss.ts",
    );
    expectCandidate(root, lesson.id);
  });

  it("checks every good fixture remains clean", () => {
    const root = makeLore();
    writeFixture(root, "fixtures/bad.ts", "unsafeCall();");
    writeFixture(root, "fixtures/good/clean.ts", "safeCall();");
    writeFixture(root, "fixtures/good/dirty.ts", "unsafeCall();");
    const lesson = makeBlockLesson("every-good-must-clean", {
      bad: ["fixtures/bad.ts"],
      good: ["fixtures/good/clean.ts", "fixtures/good/dirty.ts"],
    });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "good fixture triggered the detector: fixtures/good/dirty.ts",
    );
    expectCandidate(root, lesson.id);
  });

  it("rejects missing, absolute, and escaping fixture paths", () => {
    const root = makeLore();
    const outside = path.join(path.dirname(root), "outside.ts");
    fs.writeFileSync(outside, "unsafeCall();", "utf8");
    writeFixture(root, "fixtures/good.ts", "safeCall();");

    const missing = makeBlockLesson("missing-fixture", {
      bad: ["fixtures/missing.ts"],
      good: ["fixtures/good.ts"],
    });
    putLesson(root, missing);
    expect(() => approveLesson(root, missing.id)).toThrow(
      "bad fixture does not exist or is not a file",
    );

    const escaping = makeBlockLesson("escaping-fixture", {
      bad: ["../outside.ts"],
      good: ["fixtures/good.ts"],
    });
    putLesson(root, escaping);
    expect(() => approveLesson(root, escaping.id)).toThrow(
      "bad fixture escapes the lore root",
    );

    const absolute = makeBlockLesson("absolute-fixture", {
      bad: [outside],
      good: ["fixtures/good.ts"],
    });
    putLesson(root, absolute);
    expect(() => approveLesson(root, absolute.id)).toThrow(
      "bad fixture path must be relative to the lore root",
    );
  });

  it("rejects a fixture symlink whose target is outside the lore root", () => {
    const root = makeLore();
    const outside = path.join(path.dirname(root), "outside-symlink-target.ts");
    fs.writeFileSync(outside, "unsafeCall();", "utf8");
    fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "fixtures", "bad-link.ts"));
    writeFixture(root, "fixtures/good.ts", "safeCall();");
    const lesson = makeBlockLesson("symlink-fixture-escape", {
      bad: ["fixtures/bad-link.ts"],
      good: ["fixtures/good.ts"],
    });
    putLesson(root, lesson);

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "bad fixture escapes the lore root",
    );
    expectCandidate(root, lesson.id);
  });
});

function makeLore(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-approval-"));
  tempRoots.push(parent);
  const root = path.join(parent, ".pitlore");
  initLore(root);
  return root;
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function baseLesson(id: string): Record<string, unknown> {
  return {
    id,
    title: `Lesson ${id}`,
    languages: ["typescript"],
    category: "security",
    symptom: "Unsafe call reaches production",
    root_cause: "Unsafe call was not detected",
    forbid_pattern_abstract: "Calling unsafeCall",
    safe_pattern_abstract: "Use safeCall instead",
  };
}

function makeBlockLesson(
  id: string,
  fixtures: { bad: string[]; good: string[] },
  patterns = ["unsafeCall\\s*\\("],
): Lesson {
  return validateLesson({
    ...baseLesson(id),
    severity: "block",
    enforcement: { patterns, fixtures },
  });
}

function expectCandidate(root: string, id: string): void {
  expect(getLesson(loadStore(root), id)?.status).toBe("candidate");
}
