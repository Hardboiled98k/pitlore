import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkContent } from "../src/check.js";
import { rankLessons } from "../src/retrieve.js";
import { loadStore } from "../src/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = path.join(root, "seed");

describe("seed lore", () => {
  it("loads many approved lessons", () => {
    const store = loadStore(seed);
    expect(store.lessons.length).toBeGreaterThanOrEqual(20);
    expect(store.lessons.every((l) => l.status === "approved")).toBe(true);
  });

  it("retrieves async-related lessons for intent", () => {
    const store = loadStore(seed);
    const ranked = rankLessons(store, {
      intent: "await async forEach array promises",
      languages: ["typescript"],
      k: 5,
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.some((r) => r.lesson.id.includes("foreach") || r.lesson.id.includes("async"))).toBe(
      true,
    );
  });

  it("does not return unrelated lessons from approval score alone", () => {
    const store = loadStore(seed);
    const ranked = rankLessons(store, {
      intent: "calculate exoplanet ephemeris with quaternion voxels",
      files: ["src/orbital-ephemeris.ts"],
      languages: ["typescript"],
      k: 5,
    });

    expect(ranked).toEqual([]);
  });

  it("does not treat sparse incidental body tokens in a long intent as relevant", () => {
    const base = loadStore(seed);
    const dateLesson = base.lessons.find(
      (lesson) => lesson.id === "date-tz-naive",
    )!;
    const awaitLesson = base.lessons.find(
      (lesson) => lesson.id === "js-foreach-async-await-miss",
    )!;
    const reactLesson = base.lessons.find(
      (lesson) => lesson.id === "css-zindex-war",
    )!;
    const pathLesson = base.lessons.find(
      (lesson) => lesson.id === "node-path-traversal",
    )!;
    const store = { ...base, lessons: [dateLesson] };

    const unrelatedIntent =
      "validate retrieve files compatibility alias mixed input and empty values";
    const unrelated = rankLessons(store, {
      intent: unrelatedIntent,
      files: ["src/cli.ts", "tests/cli-init.test.ts"],
    });
    const unrelatedAcrossSeed = rankLessons(base, {
      intent: unrelatedIntent,
      files: ["src/cli.ts", "tests/cli-init.test.ts"],
    });
    const focusedSingleToken = rankLessons(store, { intent: "mixed" });
    const stronglyRelated = rankLessons(store, {
      intent: "timezone date parsing",
    });
    const bodyCoverageRelated = rankLessons(store, {
      intent: "local formatting mixed assumptions",
    });
    const tagAnchored = rankLessons(store, {
      intent: "fix timezone handling in reports",
    });
    const stronglyRelatedAsync = rankLessons(
      { ...base, lessons: [awaitLesson] },
      { intent: "async await mistakes" },
    );
    const tagSubstringOnly = rankLessons(store, {
      intent: "updates to cli behavior",
    });
    const shortTagSubstringOnly = rankLessons(
      { ...base, lessons: [pathLesson] },
      { intent: "offset pagination" },
    );
    const ecosystemAnchored = rankLessons(
      { ...base, lessons: [reactLesson] },
      { files: ["src/react/button.tsx"] },
    );
    const ecosystemSubstringOnly = rankLessons(
      { ...base, lessons: [reactLesson] },
      { files: ["src/reactive/button.tsx"] },
    );
    const genericEngineeringIntents = [
      "rename query helper",
      "handle missing config",
      "check date field",
      "refactor promise helper",
    ];

    expect(unrelated).toEqual([]);
    expect(unrelatedAcrossSeed).toEqual([]);
    expect(focusedSingleToken.map((item) => item.lesson.id)).toEqual([
      "date-tz-naive",
    ]);
    expect(stronglyRelated.map((item) => item.lesson.id)).toEqual([
      "date-tz-naive",
    ]);
    expect(bodyCoverageRelated.map((item) => item.lesson.id)).toEqual([
      "date-tz-naive",
    ]);
    expect(tagAnchored.map((item) => item.lesson.id)).toEqual([
      "date-tz-naive",
    ]);
    expect(stronglyRelatedAsync.map((item) => item.lesson.id)).toEqual([
      "js-foreach-async-await-miss",
    ]);
    expect(tagSubstringOnly).toEqual([]);
    expect(shortTagSubstringOnly).toEqual([]);
    expect(ecosystemAnchored.map((item) => item.lesson.id)).toEqual([
      "css-zindex-war",
    ]);
    expect(ecosystemSubstringOnly).toEqual([]);
    for (const intent of genericEngineeringIntents) {
      expect(rankLessons(base, { intent })).toEqual([]);
    }
  });

  it("matches simple English singular/plural variants without lowering the relevance floor", () => {
    const store = loadStore(seed);

    const related = rankLessons(store, {
      intent: "bounded timeout request",
      languages: ["typescript"],
    });
    const unrelated = rankLessons(store, {
      intent: "status classes",
      languages: ["typescript"],
    });

    expect(related.map((item) => item.lesson.id)).toContain("http-no-timeout");
    expect(unrelated).toEqual([]);
  });

  it("enforces scoped retrieval for relative and absolute file paths", () => {
    const base = loadStore(seed);
    const scopedLesson = {
      ...base.lessons.find((lesson) => lesson.id === "js-foreach-async-await-miss")!,
      scope: { paths: ["src/**/*.ts"] },
    };
    const scopedStore = { ...base, lessons: [scopedLesson] };

    const matching = rankLessons(scopedStore, {
      intent: "async foreach promises",
      files: ["/workspace/project/src/jobs/batch.ts"],
      languages: ["typescript"],
    });
    const unrelated = rankLessons(scopedStore, {
      intent: "async foreach promises",
      files: ["tests/jobs/batch.ts"],
      languages: ["typescript"],
    });

    expect(matching.map((item) => item.lesson.id)).toEqual([
      "js-foreach-async-await-miss",
    ]);
    expect(unrelated).toEqual([]);
  });

  it("flags bad forEach async fixture", () => {
    const store = loadStore(seed);
    const content = `
ids.forEach(async (id) => {
  await fetch(id);
});
`;
    const result = checkContent(store, content);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.lessonId === "js-foreach-async-await-miss")).toBe(
      true,
    );
  });

  it("flags python mutable default", () => {
    const store = loadStore(seed);
    const content = `def append_item(item, bucket=[]):\n    bucket.append(item)\n`;
    const result = checkContent(store, content);
    expect(
      result.findings.some((f) => f.lessonId === "python-mutable-default-arg"),
    ).toBe(true);
  });
});
