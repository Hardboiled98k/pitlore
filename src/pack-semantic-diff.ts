import { z } from "zod";
import {
  RegistryPackArtifactSchema,
  withMaterializedRegistryPackArtifact,
  type RegistryPackArtifact,
} from "./registry-artifact.js";
import {
  LessonIdSchema,
  PackNameSchema,
  SemverSchema,
  type Lesson,
  type Manifest,
} from "./schema.js";

const DEFAULT_DETAIL_LIMIT = 100;
const MAX_DETAIL_LIMIT = 100;
export const MAX_PACK_SEMANTIC_DIFF_BYTES = 128 * 1024;
const MAX_PACK_LESSONS = 1_000;

const ManifestDiffFieldSchema = z.enum([
  "description",
  "visibility",
  "dependencies",
  "default_status_for_new",
]);

const LessonSemanticFieldSchema = z.enum([
  "version",
  "title",
  "languages",
  "ecosystems",
  "category",
  "symptom",
  "root_cause",
  "forbid_pattern_abstract",
  "safe_pattern_abstract",
  "scope.paths",
  "scope.confidence_min",
  "severity",
  "confidence",
  "sources.count",
  "sources.references",
  "enforcement.test_idea",
  "enforcement.detector_ref",
  "enforcement.patterns",
  "enforcement.fixtures.bad",
  "enforcement.fixtures.good",
  "enforcement.fixtures.bad_content",
  "enforcement.fixtures.good_content",
  "tags",
  "status",
  "visibility",
]);

const LessonMetadataFieldSchema = z.enum(["created_at", "updated_at"]);
const DiffCountSchema = z.number().int().min(0).max(MAX_PACK_LESSONS);
const ArtifactIntegritySchema = z
  .string()
  .regex(/^sha256-[A-Za-z0-9+/]{43}=$/);
const ArtifactDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ArtifactDiffIdentitySchema = z
  .object({
    version: SemverSchema,
    integrity: ArtifactIntegritySchema,
    digest_hex: ArtifactDigestSchema,
  })
  .strict();

const LessonIdDetailBucketSchema = z
  .object({
    total: DiffCountSchema,
    items: z.array(LessonIdSchema).max(MAX_DETAIL_LIMIT),
    omitted: DiffCountSchema,
  })
  .strict()
  .superRefine((bucket, context) => {
    if (bucket.total !== bucket.items.length + bucket.omitted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "diff detail total must equal returned plus omitted items",
      });
    }
    if (new Set(bucket.items).size !== bucket.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "diff detail Lesson ids must be unique",
      });
    }
  });

const ChangedLessonSchema = z
  .object({
    id: LessonIdSchema,
    semantic_fields: z
      .array(LessonSemanticFieldSchema)
      .max(LessonSemanticFieldSchema.options.length),
    metadata_fields: z
      .array(LessonMetadataFieldSchema)
      .max(LessonMetadataFieldSchema.options.length),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.semantic_fields.length === 0 && item.metadata_fields.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed Lesson must report at least one changed field",
      });
    }
    if (new Set(item.semantic_fields).size !== item.semantic_fields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semantic_fields"],
        message: "semantic field changes must be unique",
      });
    }
    if (new Set(item.metadata_fields).size !== item.metadata_fields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata_fields"],
        message: "metadata field changes must be unique",
      });
    }
  });

const ChangedLessonDetailBucketSchema = z
  .object({
    total: DiffCountSchema,
    items: z.array(ChangedLessonSchema).max(MAX_DETAIL_LIMIT),
    omitted: DiffCountSchema,
  })
  .strict()
  .superRefine((bucket, context) => {
    if (bucket.total !== bucket.items.length + bucket.omitted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed detail total must equal returned plus omitted items",
      });
    }
    const ids = bucket.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "changed Lesson ids must be unique",
      });
    }
  });

export const PackSemanticDiffSchema = z
  .object({
    format: z.literal("pitlore.pack.semantic-diff.v1"),
    pack_name: PackNameSchema,
    from: ArtifactDiffIdentitySchema,
    to: ArtifactDiffIdentitySchema,
    payload: z
      .object({
        canonical_payload_changed: z.boolean(),
        artifact_digest_changed: z.boolean(),
      })
      .strict(),
    manifest: z
      .object({
        changed_fields: z
          .array(ManifestDiffFieldSchema)
          .max(ManifestDiffFieldSchema.options.length),
      })
      .strict(),
    lessons: z
      .object({
        before_count: DiffCountSchema,
        after_count: DiffCountSchema,
        unchanged_count: DiffCountSchema,
        added: LessonIdDetailBucketSchema,
        removed: LessonIdDetailBucketSchema,
        changed: ChangedLessonDetailBucketSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((diff, context) => {
    const canonicalPayloadChanged =
      diff.from.integrity !== diff.to.integrity;
    const artifactDigestChanged =
      diff.from.digest_hex !== diff.to.digest_hex;
    if (
      diff.from.version === diff.to.version &&
      (canonicalPayloadChanged || artifactDigestChanged)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to", "version"],
        message: "one immutable Pack version cannot identify different artifacts",
      });
    }
    if (
      diff.payload.canonical_payload_changed !== canonicalPayloadChanged
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "canonical_payload_changed"],
        message: "canonical payload flag must match artifact integrity",
      });
    }
    if (diff.payload.artifact_digest_changed !== artifactDigestChanged) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "artifact_digest_changed"],
        message: "artifact digest flag must match artifact digests",
      });
    }
    if (
      diff.lessons.before_count !==
      diff.lessons.removed.total +
        diff.lessons.changed.total +
        diff.lessons.unchanged_count
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lessons", "before_count"],
        message: "before count does not match Lesson diff totals",
      });
    }
    if (
      diff.lessons.after_count !==
      diff.lessons.added.total +
        diff.lessons.changed.total +
        diff.lessons.unchanged_count
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lessons", "after_count"],
        message: "after count does not match Lesson diff totals",
      });
    }
    if (
      new Set(diff.manifest.changed_fields).size !==
      diff.manifest.changed_fields.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifest", "changed_fields"],
        message: "manifest field changes must be unique",
      });
    }
    const returnedLessonIds = [
      ...diff.lessons.added.items,
      ...diff.lessons.removed.items,
      ...diff.lessons.changed.items.map((item) => item.id),
    ];
    if (new Set(returnedLessonIds).size !== returnedLessonIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lessons"],
        message: "returned Lesson ids must not overlap across change buckets",
      });
    }
  });

export type PackSemanticDiff = z.infer<typeof PackSemanticDiffSchema>;

export interface PackSemanticDiffOptions {
  detailLimit?: number;
}

type LessonSemanticField = z.infer<typeof LessonSemanticFieldSchema>;
type LessonMetadataField = z.infer<typeof LessonMetadataFieldSchema>;
type ManifestDiffField = z.infer<typeof ManifestDiffFieldSchema>;
type ChangedLesson = z.infer<typeof ChangedLessonSchema>;
type ArtifactFileHashes = ReadonlyMap<string, string>;

class ExpectedSemanticDiffError extends Error {}

export function diffRegistryPackArtifacts(
  fromInput: unknown,
  toInput: unknown,
  options: PackSemanticDiffOptions = {},
): PackSemanticDiff {
  const detailLimit = z
    .number()
    .int()
    .min(0)
    .max(MAX_DETAIL_LIMIT)
    .default(DEFAULT_DETAIL_LIMIT)
    .parse(options.detailLimit);
  const fromArtifact = parseArtifact(fromInput, "from");
  const toArtifact = parseArtifact(toInput, "to");

  if (fromArtifact.name !== toArtifact.name) {
    throw new ExpectedSemanticDiffError(
      "Registry Pack semantic diff requires matching Pack names",
    );
  }

  try {
    return withMaterializedRegistryPackArtifact(fromArtifact, (fromPack) =>
      withMaterializedRegistryPackArtifact(toArtifact, (toPack) => {
        if (
          fromArtifact.version === toArtifact.version &&
          (fromArtifact.integrity !== toArtifact.integrity ||
            fromArtifact.digest_hex !== toArtifact.digest_hex)
        ) {
          throw new ExpectedSemanticDiffError(
            "Registry Pack semantic diff found different content at one immutable name@version",
          );
        }

        return buildSemanticDiff(
          fromArtifact,
          toArtifact,
          fromPack.store.manifest,
          toPack.store.manifest,
          fromPack.store.lessons,
          toPack.store.lessons,
          detailLimit,
        );
      }),
    );
  } catch (error) {
    if (error instanceof ExpectedSemanticDiffError) throw error;
    throw new Error("Registry Pack semantic diff requires two valid Pack artifacts");
  }
}

function parseArtifact(input: unknown, side: "from" | "to"): RegistryPackArtifact {
  try {
    return RegistryPackArtifactSchema.parse(input);
  } catch {
    throw new ExpectedSemanticDiffError(
      `Registry Pack semantic diff ${side} artifact is invalid`,
    );
  }
}

function buildSemanticDiff(
  fromArtifact: RegistryPackArtifact,
  toArtifact: RegistryPackArtifact,
  fromManifest: Manifest,
  toManifest: Manifest,
  fromLessons: readonly Lesson[],
  toLessons: readonly Lesson[],
  detailLimit: number,
): PackSemanticDiff {
  const fromHashes = artifactFileHashes(fromArtifact);
  const toHashes = artifactFileHashes(toArtifact);
  const before = new Map(fromLessons.map((lesson) => [lesson.id, lesson]));
  const after = new Map(toLessons.map((lesson) => [lesson.id, lesson]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedLesson[] = [];
  let unchangedCount = 0;

  for (const id of ids) {
    const fromLesson = before.get(id);
    const toLesson = after.get(id);
    if (!fromLesson) {
      added.push(id);
      continue;
    }
    if (!toLesson) {
      removed.push(id);
      continue;
    }
    const item = compareLessons(
      fromLesson,
      toLesson,
      fromHashes,
      toHashes,
    );
    if (item.semantic_fields.length === 0 && item.metadata_fields.length === 0) {
      unchangedCount += 1;
    } else {
      changed.push(item);
    }
  }

  const result = PackSemanticDiffSchema.parse({
    format: "pitlore.pack.semantic-diff.v1",
    pack_name: fromArtifact.name,
    from: artifactIdentity(fromArtifact),
    to: artifactIdentity(toArtifact),
    payload: {
      canonical_payload_changed:
        fromArtifact.integrity !== toArtifact.integrity,
      artifact_digest_changed:
        fromArtifact.digest_hex !== toArtifact.digest_hex,
    },
    manifest: {
      changed_fields: compareManifests(fromManifest, toManifest),
    },
    lessons: {
      before_count: fromLessons.length,
      after_count: toLessons.length,
      unchanged_count: unchangedCount,
      added: detailBucket(added, detailLimit),
      removed: detailBucket(removed, detailLimit),
      changed: detailBucket(changed, detailLimit),
    },
  });

  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    MAX_PACK_SEMANTIC_DIFF_BYTES
  ) {
    throw new ExpectedSemanticDiffError(
      `Registry Pack semantic diff exceeds ${MAX_PACK_SEMANTIC_DIFF_BYTES} serialized bytes`,
    );
  }
  return result;
}

function artifactIdentity(artifact: RegistryPackArtifact) {
  return {
    version: artifact.version,
    integrity: artifact.integrity,
    digest_hex: artifact.digest_hex,
  };
}

function artifactFileHashes(artifact: RegistryPackArtifact): ArtifactFileHashes {
  return new Map(artifact.files.map((file) => [file.path, file.sha256]));
}

function compareManifests(
  from: Manifest,
  to: Manifest,
): ManifestDiffField[] {
  const fields: ManifestDiffField[] = [];
  if (from.description !== to.description) fields.push("description");
  if (from.visibility !== to.visibility) fields.push("visibility");
  if (!sameStringRecord(from.dependencies, to.dependencies)) {
    fields.push("dependencies");
  }
  if (from.default_status_for_new !== to.default_status_for_new) {
    fields.push("default_status_for_new");
  }
  return fields;
}

function compareLessons(
  from: Lesson,
  to: Lesson,
  fromHashes: ArtifactFileHashes,
  toHashes: ArtifactFileHashes,
): ChangedLesson {
  const semanticFields: LessonSemanticField[] = [];
  const metadataFields: LessonMetadataField[] = [];
  const changed = (field: LessonSemanticField, equal: boolean): void => {
    if (!equal) semanticFields.push(field);
  };

  changed("version", from.version === to.version);
  changed("title", from.title === to.title);
  changed("languages", sameStringMultiset(from.languages, to.languages));
  changed("ecosystems", sameStringMultiset(from.ecosystems, to.ecosystems));
  changed("category", from.category === to.category);
  changed("symptom", from.symptom === to.symptom);
  changed("root_cause", from.root_cause === to.root_cause);
  changed(
    "forbid_pattern_abstract",
    from.forbid_pattern_abstract === to.forbid_pattern_abstract,
  );
  changed(
    "safe_pattern_abstract",
    from.safe_pattern_abstract === to.safe_pattern_abstract,
  );
  changed("scope.paths", sameStringMultiset(from.scope.paths, to.scope.paths));
  changed(
    "scope.confidence_min",
    from.scope.confidence_min === to.scope.confidence_min,
  );
  changed("severity", from.severity === to.severity);
  changed("confidence", from.confidence === to.confidence);
  changed("sources.count", from.sources.count === to.sources.count);
  changed(
    "sources.references",
    sameStringMultiset(from.sources.references, to.sources.references),
  );
  changed(
    "enforcement.test_idea",
    from.enforcement.test_idea === to.enforcement.test_idea,
  );
  changed(
    "enforcement.detector_ref",
    from.enforcement.detector_ref === to.enforcement.detector_ref,
  );
  changed(
    "enforcement.patterns",
    sameOrderedStrings(from.enforcement.patterns, to.enforcement.patterns),
  );
  const badPathsEqual = sameStringMultiset(
    from.enforcement.fixtures.bad,
    to.enforcement.fixtures.bad,
  );
  changed("enforcement.fixtures.bad", badPathsEqual);
  const goodPathsEqual = sameStringMultiset(
    from.enforcement.fixtures.good,
    to.enforcement.fixtures.good,
  );
  changed("enforcement.fixtures.good", goodPathsEqual);
  changed(
    "enforcement.fixtures.bad_content",
    !badPathsEqual ||
      sameFixtureContents(
        from.enforcement.fixtures.bad,
        fromHashes,
        toHashes,
      ),
  );
  changed(
    "enforcement.fixtures.good_content",
    !goodPathsEqual ||
      sameFixtureContents(
        from.enforcement.fixtures.good,
        fromHashes,
        toHashes,
      ),
  );
  changed("tags", sameStringMultiset(from.tags, to.tags));
  changed("status", from.status === to.status);
  changed("visibility", from.visibility === to.visibility);

  if (from.created_at !== to.created_at) metadataFields.push("created_at");
  if (from.updated_at !== to.updated_at) metadataFields.push("updated_at");

  return {
    id: from.id,
    semantic_fields: semanticFields,
    metadata_fields: metadataFields,
  };
}

function sameFixtureContents(
  paths: readonly string[],
  fromHashes: ArtifactFileHashes,
  toHashes: ArtifactFileHashes,
): boolean {
  for (const fixture of paths) {
    const fromHash = fromHashes.get(fixture);
    const toHash = toHashes.get(fixture);
    if (fromHash === undefined || toHash === undefined) {
      throw new ExpectedSemanticDiffError(
        "Registry Pack semantic diff could not resolve a verified fixture",
      );
    }
    if (fromHash !== toHash) return false;
  }
  return true;
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameStringMultiset(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return sameOrderedStrings([...left].sort(compareText), [...right].sort(compareText));
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => compareText(a, b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => compareText(a, b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1],
    )
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function detailBucket<T>(items: readonly T[], limit: number) {
  const returned = items.slice(0, limit);
  return {
    total: items.length,
    items: returned,
    omitted: items.length - returned.length,
  };
}
