import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  PackSemanticDiffSchema,
  diffRegistryPackArtifacts,
} from "../src/pack-semantic-diff.js";
import { createRegistryPackArtifact } from "../src/registry-artifact.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import { initLore } from "../src/store.js";

const tempRoots: string[] = [];
let packSequence = 0;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Registry Pack semantic diff", () => {
  it("reports deterministic structural changes without returning private values", () => {
    const unchanged = privateLesson("unchanged-lesson");
    const fromChanged = privateLesson("changed-lesson", {
      symptom: "Internal failure at /Users/alice/customer-one",
      sources: {
        count: 1,
        references: ["https://internal.example.test/private-source"],
      },
      enforcement: {
        test_idea: "Private test idea",
        detector_ref: null,
        patterns: ["oldPrivatePattern\\s*\\("],
        fixtures: { bad: [], good: [] },
      },
      updated_at: "2026-07-20T00:00:00.000Z",
    });
    const toChanged = privateLesson("changed-lesson", {
      symptom: "Different confidential symptom",
      sources: {
        count: 1,
        references: ["https://other.internal.test/private-source"],
      },
      enforcement: {
        test_idea: "Private test idea",
        detector_ref: null,
        patterns: ["newPrivatePattern\\s*\\("],
        fixtures: { bad: [], good: [] },
      },
      updated_at: "2026-07-21T00:00:00.000Z",
    });
    const from = makeArtifact("acme/private-diff", "1.0.0", [
      unchanged,
      fromChanged,
      privateLesson("removed-lesson"),
    ], {
      description: "Confidential before description",
      dependencies: { "acme/base": "^1.0.0" },
    });
    const to = makeArtifact("acme/private-diff", "1.1.0", [
      unchanged,
      toChanged,
      privateLesson("added-lesson"),
    ], {
      description: "Confidential after description",
      dependencies: { "acme/base": "^2.0.0" },
    });

    const result = diffRegistryPackArtifacts(from, to);

    expect(result).toMatchObject({
      format: "pitlore.pack.semantic-diff.v1",
      pack_name: "acme/private-diff",
      from: {
        version: "1.0.0",
        integrity: from.integrity,
        digest_hex: from.digest_hex,
      },
      to: {
        version: "1.1.0",
        integrity: to.integrity,
        digest_hex: to.digest_hex,
      },
      payload: {
        canonical_payload_changed: true,
        artifact_digest_changed: true,
      },
      manifest: { changed_fields: ["description", "dependencies"] },
      lessons: {
        before_count: 3,
        after_count: 3,
        unchanged_count: 1,
        added: { total: 1, items: ["added-lesson"], omitted: 0 },
        removed: { total: 1, items: ["removed-lesson"], omitted: 0 },
        changed: {
          total: 1,
          items: [
            {
              id: "changed-lesson",
              semantic_fields: [
                "symptom",
                "sources.references",
                "enforcement.patterns",
              ],
              metadata_fields: ["updated_at"],
            },
          ],
          omitted: 0,
        },
      },
    });
    expect(PackSemanticDiffSchema.parse(result)).toEqual(result);

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      "Confidential before description",
      "Confidential after description",
      "/Users/alice/customer-one",
      "Different confidential symptom",
      "internal.example.test",
      "other.internal.test",
      "oldPrivatePattern",
      "newPrivatePattern",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      128 * 1024,
    );
  });

  it("normalizes set-like arrays but keeps detector pattern order observable", () => {
    const files = {
      "fixtures/bad-a.ts": "dangerOne();\n",
      "fixtures/bad-b.ts": "dangerTwo();\n",
      "fixtures/good-a.ts": "safeOne();\n",
      "fixtures/good-b.ts": "safeTwo();\n",
    };
    const fromLesson = privateLesson("array-order", {
      languages: ["typescript", "javascript"],
      ecosystems: ["node", "web"],
      scope: { paths: ["src/**", "tests/**"], confidence_min: 0.6 },
      sources: { count: 2, references: ["reference-b", "reference-a"] },
      enforcement: {
        test_idea: "Exercise both patterns",
        detector_ref: null,
        patterns: ["dangerOne\\(", "dangerTwo\\("],
        fixtures: {
          bad: ["fixtures/bad-a.ts", "fixtures/bad-b.ts"],
          good: ["fixtures/good-a.ts", "fixtures/good-b.ts"],
        },
      },
      tags: ["reliability", "node"],
    });
    const reordered = privateLesson("array-order", {
      languages: ["javascript", "typescript"],
      ecosystems: ["web", "node"],
      scope: { paths: ["tests/**", "src/**"], confidence_min: 0.6 },
      sources: { count: 2, references: ["reference-a", "reference-b"] },
      enforcement: {
        test_idea: "Exercise both patterns",
        detector_ref: null,
        patterns: ["dangerOne\\(", "dangerTwo\\("],
        fixtures: {
          bad: ["fixtures/bad-b.ts", "fixtures/bad-a.ts"],
          good: ["fixtures/good-b.ts", "fixtures/good-a.ts"],
        },
      },
      tags: ["node", "reliability"],
    });
    const patternsReordered = privateLesson("array-order", {
      ...reordered,
      enforcement: {
        ...reordered.enforcement,
        patterns: ["dangerTwo\\(", "dangerOne\\("],
      },
    });
    const from = makeArtifact("acme/normalization", "1.0.0", [fromLesson], {
      files,
    });
    const setOnly = makeArtifact("acme/normalization", "1.0.1", [reordered], {
      files,
    });
    const patternOrder = makeArtifact(
      "acme/normalization",
      "1.0.2",
      [patternsReordered],
      { files },
    );

    expect(diffRegistryPackArtifacts(from, setOnly).lessons).toMatchObject({
      unchanged_count: 1,
      changed: { total: 0, items: [], omitted: 0 },
    });
    expect(
      diffRegistryPackArtifacts(setOnly, patternOrder).lessons.changed.items,
    ).toEqual([
      {
        id: "array-order",
        semantic_fields: ["enforcement.patterns"],
        metadata_fields: [],
      },
    ]);
  });

  it("detects verified fixture body changes without disclosing paths or bodies", () => {
    const lesson = privateLesson("fixture-body", {
      enforcement: {
        test_idea: "Fixture remains safe",
        detector_ref: null,
        patterns: [],
        fixtures: { bad: [], good: ["fixtures/confidential-safe.ts"] },
      },
    });
    const from = makeArtifact("acme/fixture-diff", "1.0.0", [lesson], {
      files: { "fixtures/confidential-safe.ts": "firstPrivateBody();\n" },
    });
    const to = makeArtifact("acme/fixture-diff", "1.0.1", [lesson], {
      files: { "fixtures/confidential-safe.ts": "secondPrivateBody();\n" },
    });

    const result = diffRegistryPackArtifacts(from, to);
    expect(result.lessons.changed.items).toEqual([
      {
        id: "fixture-body",
        semantic_fields: ["enforcement.fixtures.good_content"],
        metadata_fields: [],
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("confidential-safe.ts");
    expect(serialized).not.toContain("firstPrivateBody");
    expect(serialized).not.toContain("secondPrivateBody");
  });

  it("bounds details with exact totals and stable ASCII ordering", () => {
    const from = makeArtifact(
      "acme/bounded-diff",
      "1.0.0",
      ["removed-c", "removed-a", "removed-b"].map((id) => privateLesson(id)),
    );
    const to = makeArtifact(
      "acme/bounded-diff",
      "2.0.0",
      ["added-c", "added-a", "added-b"].map((id) => privateLesson(id)),
    );

    const result = diffRegistryPackArtifacts(from, to, { detailLimit: 2 });
    expect(result.lessons.added).toEqual({
      total: 3,
      items: ["added-a", "added-b"],
      omitted: 1,
    });
    expect(result.lessons.removed).toEqual({
      total: 3,
      items: ["removed-a", "removed-b"],
      omitted: 1,
    });
    expect(() =>
      diffRegistryPackArtifacts(from, to, { detailLimit: 101 }),
    ).toThrow();
  });

  it("fully revalidates artifacts and enforces Pack identity immutability", () => {
    const base = makeArtifact("acme/identity", "1.0.0", [
      privateLesson("identity-lesson"),
    ]);
    const changedAtSameVersion = makeArtifact("acme/identity", "1.0.0", [
      privateLesson("identity-lesson", { title: "Different private title" }),
    ]);
    const otherPack = makeArtifact("acme/other", "1.1.0", [
      privateLesson("identity-lesson"),
    ]);

    expect(diffRegistryPackArtifacts(base, base).lessons).toMatchObject({
      unchanged_count: 1,
      changed: { total: 0 },
    });
    expect(() => diffRegistryPackArtifacts(base, changedAtSameVersion)).toThrow(
      /immutable name@version/,
    );
    expect(() => diffRegistryPackArtifacts(base, otherPack)).toThrow(
      /matching Pack names/,
    );

    const first = base.files[0];
    if (!first) throw new Error("expected artifact file");
    const tampered = {
      ...base,
      files: [
        {
          ...first,
          content_base64: Buffer.from("private tampered body").toString("base64"),
        },
        ...base.files.slice(1),
      ],
    };
    expect(() => diffRegistryPackArtifacts(tampered, base)).toThrow(
      /from artifact is invalid/,
    );
    expect(() => diffRegistryPackArtifacts(tampered, base)).not.toThrow(
      /private tampered body/,
    );
  });

  it("rejects impossible wire identities and change flags", () => {
    const from = makeArtifact("acme/wire-invariants", "1.0.0", [
      privateLesson("wire-invariant"),
    ]);
    const to = makeArtifact("acme/wire-invariants", "2.0.0", [
      privateLesson("wire-invariant", { symptom: "A changed private symptom" }),
    ]);
    const valid = diffRegistryPackArtifacts(from, to);

    expect(() =>
      PackSemanticDiffSchema.parse({
        ...valid,
        payload: { ...valid.payload, canonical_payload_changed: false },
      }),
    ).toThrow(/canonical payload flag/);
    expect(() =>
      PackSemanticDiffSchema.parse({
        ...valid,
        payload: { ...valid.payload, artifact_digest_changed: false },
      }),
    ).toThrow(/artifact digest flag/);
    expect(() =>
      PackSemanticDiffSchema.parse({
        ...valid,
        to: { ...valid.to, version: valid.from.version },
      }),
    ).toThrow(/immutable Pack version/);
    expect(() =>
      PackSemanticDiffSchema.parse({
        ...valid,
        lessons: {
          ...valid.lessons,
          before_count: valid.lessons.before_count + 1,
          removed: {
            total: 1,
            items: [valid.lessons.changed.items[0]?.id],
            omitted: 0,
          },
        },
      }),
    ).toThrow(/must not overlap/);
  });
});

function makeArtifact(
  name: string,
  version: string,
  lessons: readonly Lesson[],
  options: {
    description?: string;
    dependencies?: Record<string, string>;
    files?: Record<string, string>;
  } = {},
) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-semantic-diff-"));
  tempRoots.push(parent);
  const root = path.join(parent, `pack-${packSequence++}`);
  initLore(root, { name, visibility: "private", copySeed: false });
  const manifestPath = path.join(root, "manifest.yaml");
  const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    manifestPath,
    yaml.dump({
      ...manifest,
      description: options.description ?? "Private semantic diff fixture",
      version,
      dependencies: options.dependencies ?? {},
    }),
    "utf8",
  );
  for (const lesson of lessons) {
    fs.writeFileSync(
      path.join(root, "lessons", `${lesson.id}.yaml`),
      yaml.dump(lesson),
      "utf8",
    );
  }
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const filename = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, "utf8");
  }
  return createRegistryPackArtifact(root);
}

function privateLesson(id: string, overrides: Partial<Lesson> = {}): Lesson {
  return validateLesson({
    id,
    version: "1.0.0",
    title: `Private ${id}`,
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "reliability",
    symptom: "A private operation fails",
    root_cause: "A private boundary was not enforced",
    forbid_pattern_abstract: "Skipping the private boundary",
    safe_pattern_abstract: "Validate the private boundary first",
    scope: { paths: [] },
    severity: "warn",
    confidence: 0.9,
    sources: { count: 1, references: [] },
    enforcement: {
      test_idea: "Exercise the private boundary",
      detector_ref: null,
      patterns: [],
      fixtures: { bad: [], good: [] },
    },
    tags: ["private"],
    status: "approved",
    visibility: "private",
    ...overrides,
  });
}
