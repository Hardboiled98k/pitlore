import { describe, expect, it } from "vitest";
import type { VerifiedPack } from "../src/pack.js";
import {
  EMPTY_PUBLIC_PACK_DISCOVERY_DOCUMENT,
  PublicPackDiscoveryDocumentSchema,
  buildPublicPackDiscoveryDocument,
  emptyPublicPackDiscoveryDocument,
  matchesPublicPackDiscoveryFilter,
  normalizePublicPackDiscoveryFacet,
  normalizePublicPackDiscoveryFilter,
} from "../src/registry-search.js";
import { validateLesson, validateManifest, type Lesson } from "../src/schema.js";

describe("public Pack discovery core", () => {
  it("normalizes case, compatibility forms, whitespace, and duplicate filter values", () => {
    expect(normalizePublicPackDiscoveryFacet("  ＴｙｐｅＳｃｒｉｐｔ  ")).toBe(
      "typescript",
    );
    expect(
      normalizePublicPackDiscoveryFilter({
        languages: [" TypeScript ", "ＴＹＰＥＳＣＲＩＰＴ", "Rust"],
        ecosystems: [" Node.JS ", "NODE.JS"],
        tags: [" Reliability ", "SECURITY"],
      }),
    ).toEqual({
      languages: ["rust", "typescript"],
      ecosystems: ["node.js"],
      tags: ["reliability", "security"],
    });
  });

  it("preserves punctuation-bearing ecosystem names", () => {
    expect(
      normalizePublicPackDiscoveryFilter({
        languages: ["C++", "C#", ".NET"],
      }).languages,
    ).toEqual([".net", "c#", "c++"]);
  });

  it("rejects empty, controlled, oversized, and over-wide filter input", () => {
    expect(() => normalizePublicPackDiscoveryFacet("   ")).toThrow(/empty/);
    expect(() => normalizePublicPackDiscoveryFacet("node\u0000js")).toThrow(
      /control/,
    );
    expect(() => normalizePublicPackDiscoveryFacet("node\u0085js")).toThrow(
      /control/,
    );
    expect(normalizePublicPackDiscoveryFacet("a".repeat(64))).toHaveLength(64);
    expect(() => normalizePublicPackDiscoveryFacet("a".repeat(65))).toThrow(
      /at most 64/,
    );
    expect(() =>
      normalizePublicPackDiscoveryFilter({
        tags: ["one", "two", "three", "four", "five"],
      }),
    ).toThrow(/at most 4/);
    expect(() =>
      normalizePublicPackDiscoveryFilter({ tags: null } as never),
    ).toThrow(/must be an array/);
  });

  it("enforces a strict canonical discovery document schema", () => {
    expect(
      PublicPackDiscoveryDocumentSchema.parse({
        version: 1,
        description: "  A public Pack  ",
        languages: ["rust", "typescript"],
        ecosystems: ["node"],
        tags: [],
        lesson_count: 2,
      }),
    ).toEqual({
      version: 1,
      description: "A public Pack",
      languages: ["rust", "typescript"],
      ecosystems: ["node"],
      tags: [],
      lesson_count: 2,
    });

    const valid = emptyPublicPackDiscoveryDocument();
    expect(valid).toEqual(EMPTY_PUBLIC_PACK_DISCOVERY_DOCUMENT);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({ ...valid, extra: true }),
    ).toThrow();
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        languages: ["typescript", "rust"],
      }),
    ).toThrow(/sorted and unique/);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        languages: ["rust", "rust"],
      }),
    ).toThrow(/sorted and unique/);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        languages: ["TypeScript"],
      }),
    ).toThrow(/canonical/);
  });

  it("enforces description and per-dimension 64/65 boundaries", () => {
    const valid = emptyPublicPackDiscoveryDocument();
    expect(
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        description: "d".repeat(512),
        tags: Array.from(
          { length: 64 },
          (_, index) => `tag-${String(index).padStart(2, "0")}`,
        ),
      }).tags,
    ).toHaveLength(64);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        description: "d".repeat(513),
      }),
    ).toThrow(/at most 512/);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        description: "line one\nline two",
      }),
    ).toThrow(/control/);
    expect(() =>
      PublicPackDiscoveryDocumentSchema.parse({
        ...valid,
        tags: Array.from(
          { length: 65 },
          (_, index) => `tag-${String(index).padStart(2, "0")}`,
        ),
      }),
    ).toThrow();
  });

  it("aggregates only approved Lessons and returns canonical facets", () => {
    const pack = verifiedPack([
      lesson("approved-one", {
        status: "approved",
        languages: [" TypeScript ", "ＲＵＳＴ"],
        ecosystems: ["Node", ".NET"],
        tags: ["Security", "C++"],
      }),
      lesson("approved-two", {
        status: "approved",
        languages: ["typescript"],
        ecosystems: ["NODE"],
        tags: ["C#"],
      }),
      lesson("deprecated-one", {
        status: "deprecated",
        languages: ["obsolete"],
        ecosystems: ["legacy"],
        tags: ["retired"],
      }),
      lesson("candidate-one", {
        status: "candidate",
        languages: ["unreviewed"],
      }),
    ], "  Public discovery fixture  ");

    expect(buildPublicPackDiscoveryDocument(pack)).toEqual({
      version: 1,
      description: "Public discovery fixture",
      languages: ["rust", "typescript"],
      ecosystems: [".net", "node"],
      tags: ["c#", "c++", "security"],
      lesson_count: 2,
    });
  });

  it("ignores deprecated metadata but fails closed on active invalid or excessive facets", () => {
    expect(() =>
      buildPublicPackDiscoveryDocument(
        verifiedPack([
          lesson("approved-one", { status: "approved" }),
          lesson("deprecated-one", {
            status: "deprecated",
            tags: ["bad\u0000value", "x".repeat(65)],
          }),
        ]),
      ),
    ).not.toThrow();

    expect(() =>
      buildPublicPackDiscoveryDocument(
        verifiedPack([
          lesson("approved-one", {
            status: "approved",
            tags: ["bad\u0000value"],
          }),
        ]),
      ),
    ).toThrow(/control/);

    const excessive = Array.from({ length: 65 }, (_, index) =>
      lesson(`approved-${String(index).padStart(2, "0")}`, {
        status: "approved",
        tags: [`tag-${String(index).padStart(2, "0")}`],
      }),
    );
    expect(() =>
      buildPublicPackDiscoveryDocument(verifiedPack(excessive)),
    ).toThrow(/tags exceeds 64/);
  });

  it("matches OR within a dimension and AND across dimensions", () => {
    const document = PublicPackDiscoveryDocumentSchema.parse({
      version: 1,
      description: "Matcher fixture",
      languages: ["rust", "typescript"],
      ecosystems: ["node", "web"],
      tags: ["reliability", "security"],
      lesson_count: 3,
    });

    expect(matchesPublicPackDiscoveryFilter(document)).toBe(true);
    expect(
      matchesPublicPackDiscoveryFilter(document, {
        languages: ["Go", "ＲＵＳＴ"],
      }),
    ).toBe(true);
    expect(
      matchesPublicPackDiscoveryFilter(document, {
        languages: ["Go", "Java"],
      }),
    ).toBe(false);
    expect(
      matchesPublicPackDiscoveryFilter(document, {
        languages: ["Rust", "Go"],
        ecosystems: ["NODE"],
        tags: ["Security", "Correctness"],
      }),
    ).toBe(true);
    expect(
      matchesPublicPackDiscoveryFilter(document, {
        languages: ["Rust"],
        ecosystems: ["Deno"],
        tags: ["Security"],
      }),
    ).toBe(false);
  });
});

function verifiedPack(lessons: Lesson[], description = "Fixture"): VerifiedPack {
  return {
    root: "/fixture",
    files: [],
    integrity: `sha256-${"a".repeat(44)}`,
    digestHex: "a".repeat(64),
    signature: { status: "unverified" },
    store: {
      root: "/fixture",
      manifest: validateManifest({
        name: "acme/discovery",
        description,
        visibility: "public",
        version: "1.0.0",
        dependencies: {},
        default_status_for_new: "candidate",
      }),
      lessons,
      loadErrors: [],
    },
  };
}

function lesson(
  id: string,
  overrides: Partial<Lesson> = {},
): Lesson {
  return validateLesson({
    id,
    version: "1.0.0",
    title: `Public ${id}`,
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "reliability",
    symptom: "A request can hang",
    root_cause: "No bounded deadline",
    forbid_pattern_abstract: "Unbounded remote calls",
    safe_pattern_abstract: "Use a bounded deadline",
    scope: { paths: [] },
    severity: "warn",
    confidence: 0.9,
    sources: { count: 1, references: [] },
    enforcement: {
      test_idea: "simulate a timeout",
      detector_ref: null,
      patterns: [],
      fixtures: { bad: [], good: [] },
    },
    tags: [],
    status: "approved",
    visibility: "public",
    ...overrides,
  });
}
