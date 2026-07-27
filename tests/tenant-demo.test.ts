import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkContent } from "../src/check.js";
import { rankLessons } from "../src/retrieve.js";
import { approveLesson, loadStore } from "../src/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = path.join(root, "demo", "tenant-isolation");
const candidateLoreRoot = path.join(demoRoot, "lore");
const fixtureRoot = path.join(candidateLoreRoot, "fixtures");
const lessonId = "tenant-query-requires-tenant-id";
const temporaryRoots: string[] = [];

const retrieveContext = {
  intent: "review a multi-tenant project query for missing tenantId",
  files: ["demo/tenant-isolation/lore/fixtures/bad/tenant-missing.ts"],
  languages: ["typescript"],
};

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function readFixture(name: string): { content: string; filePath: string } {
  const filePath = path.join(fixtureRoot, name);
  return { content: fs.readFileSync(filePath, "utf8"), filePath };
}

describe("tenant isolation repository demo", () => {
  it("loads a private candidate that default retrieval does not trust", () => {
    const store = loadStore(candidateLoreRoot);

    expect(store.loadErrors).toEqual([]);
    expect(store.manifest.visibility).toBe("private");
    expect(store.lessons).toHaveLength(1);
    expect(store.lessons[0]).toMatchObject({
      id: lessonId,
      status: "candidate",
      visibility: "private",
      enforcement: {
        fixtures: {
          bad: ["fixtures/bad/tenant-missing.ts"],
          good: ["fixtures/good/tenant-scoped.ts"],
        },
      },
    });
    expect(rankLessons(store, retrieveContext)).toEqual([]);
    expect(
      rankLessons(store, { ...retrieveContext, includeCandidate: true })[0]?.lesson
        .id,
    ).toBe(lessonId);
  });

  it("flags the missing tenantId fixture and keeps the scoped fixture clean", () => {
    const store = loadStore(candidateLoreRoot);
    const bad = readFixture("bad/tenant-missing.ts");
    const good = readFixture("good/tenant-scoped.ts");

    const badResult = checkContent(store, bad.content, {
      filePath: bad.filePath,
      onlyApproved: false,
    });
    const goodResult = checkContent(store, good.content, {
      filePath: good.filePath,
      onlyApproved: false,
    });

    expect(badResult.configurationErrors).toEqual([]);
    expect(badResult.findings).toEqual([
      expect.objectContaining({ lessonId, severity: "block" }),
    ]);
    expect(goodResult).toEqual({
      clean: true,
      findings: [],
      configurationErrors: [],
    });
  });

  it("enters default retrieve and check only after explicit human approval", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pitlore-tenant-demo-"),
    );
    temporaryRoots.push(temporaryRoot);
    const temporaryLoreRoot = path.join(temporaryRoot, "lore");
    fs.cpSync(candidateLoreRoot, temporaryLoreRoot, { recursive: true });

    expect(loadStore(temporaryLoreRoot).lessons[0]?.status).toBe("candidate");
    approveLesson(temporaryLoreRoot, lessonId);

    const approvedStore = loadStore(temporaryLoreRoot);
    const bad = readFixture("bad/tenant-missing.ts");
    const good = readFixture("good/tenant-scoped.ts");

    expect(approvedStore.lessons[0]?.status).toBe("approved");
    expect(rankLessons(approvedStore, retrieveContext)[0]?.lesson.id).toBe(
      lessonId,
    );
    expect(
      checkContent(approvedStore, bad.content, { filePath: bad.filePath })
        .findings[0]?.lessonId,
    ).toBe(lessonId);
    expect(
      checkContent(approvedStore, good.content, { filePath: good.filePath }),
    ).toEqual({ clean: true, findings: [], configurationErrors: [] });
    expect(loadStore(candidateLoreRoot).lessons[0]?.status).toBe("candidate");
  });
});
