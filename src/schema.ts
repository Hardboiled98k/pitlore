import path from "node:path";
import semver from "semver";
import { z } from "zod";

export const SeveritySchema = z.enum(["info", "warn", "block"]);
export const StatusSchema = z.enum([
  "candidate",
  "approved",
  "rejected",
  "deprecated",
]);
export const VisibilitySchema = z.enum(["private", "public"]);
export const SemverSchema = z.string().refine(
  (value) =>
    value.trim() === value &&
    /^[0-9]/.test(value) &&
    semver.valid(value, { loose: false }) !== null,
  "version must be semantic version x.y.z",
);
export const SemverRangeSchema = z.string().refine(
  (value) =>
    value.trim() === value &&
    value.length > 0 &&
    semver.validRange(value, { loose: false }) !== null,
  "dependency version must be a valid semantic version range",
);
export const PackNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/,
    "pack name must use lowercase path segments",
  );
export const LessonIdSchema = z
  .string()
  .min(3)
  .max(128, "id must be at most 128 characters")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case");

export const LessonSchema = z.object({
  id: LessonIdSchema,
  version: SemverSchema.default("0.1.0"),
  title: z.string().min(3),
  languages: z.array(z.string()).min(1),
  ecosystems: z.array(z.string()).default([]),
  category: z.string().min(1),
  symptom: z.string().min(3),
  root_cause: z.string().min(3),
  forbid_pattern_abstract: z.string().min(3),
  safe_pattern_abstract: z.string().min(3),
  scope: z
    .object({
      paths: z.array(z.string()).default([]),
      confidence_min: z.number().min(0).max(1).optional(),
    })
    .default({ paths: [] }),
  severity: SeveritySchema.default("warn"),
  confidence: z.number().min(0).max(1).default(0.7),
  sources: z
    .object({
      count: z.number().int().nonnegative().default(1),
      references: z.array(z.string()).default([]),
    })
    .default({ count: 1, references: [] }),
  enforcement: z
    .object({
      test_idea: z.string().nullable().default(null),
      detector_ref: z.string().nullable().default(null),
      patterns: z.array(z.string().min(1).max(500)).max(20).default([]),
      fixtures: z
        .object({
          bad: z.array(z.string().min(1)).default([]),
          good: z.array(z.string().min(1)).default([]),
        })
        .default({ bad: [], good: [] }),
    })
    .default({
      test_idea: null,
      detector_ref: null,
      patterns: [],
      fixtures: { bad: [], good: [] },
    }),
  tags: z.array(z.string()).default([]),
  status: StatusSchema.default("candidate"),
  visibility: VisibilitySchema.default("private"),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).strict();

export type Lesson = z.infer<typeof LessonSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type LessonStatus = z.infer<typeof StatusSchema>;

export const ReviewRecommendationSchema = z.enum(["accept", "edit", "reject"]);

const ReviewTextSchema = z.string().trim().min(1).max(2_000);

export const ReviewSubmissionSchema = z
  .object({
    recommendation: ReviewRecommendationSchema,
    confidence: z.number().min(0).max(1),
    summary: ReviewTextSchema,
    strengths: z.array(ReviewTextSchema).max(10).default([]),
    risks: z.array(ReviewTextSchema).max(10).default([]),
    required_changes: z.array(ReviewTextSchema).max(10).default([]),
    reviewer: z
      .object({
        provider: z.string().trim().min(1).max(64),
        model: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict();

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ReviewEnvelopeSchema = z
  .object({
    review_context_hash: Sha256Schema,
    submission: ReviewSubmissionSchema,
  })
  .strict();

export const CandidateReviewSchema = ReviewSubmissionSchema.omit({
  reviewer: true,
})
  .extend({
    version: z.literal("0.1.0"),
    lesson_id: LessonIdSchema,
    lesson_hash: Sha256Schema,
    review_context_hash: Sha256Schema,
    approved_catalog_hash: Sha256Schema,
    fixture_hashes: z.record(Sha256Schema),
    prompt_version: z.string().trim().min(1).max(64),
    reviewer: z
      .object({
        provider: z.string().trim().min(1).max(64),
        model: z.string().trim().min(1).max(128),
        identity_trust: z.literal("self-reported"),
      })
      .strict(),
    approval_readiness: z
      .object({
        ready: z.boolean(),
        issues: z.array(ReviewTextSchema).max(20),
      })
      .strict(),
    sensitive_content_issues: z.array(ReviewTextSchema).max(20),
    reviewed_at: z.string().datetime(),
  })
  .strict();

export type ReviewRecommendation = z.infer<typeof ReviewRecommendationSchema>;
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
export type ReviewEnvelope = z.infer<typeof ReviewEnvelopeSchema>;
export type CandidateReview = z.infer<typeof CandidateReviewSchema>;

export const EvidenceSampleKindSchema = z.enum(["real", "smoke", "fixture"]);
export const DetectorClassificationSchema = z.enum(["tp", "fp", "fn"]);

const EvidenceTextSchema = z.string().trim().min(1).max(2_000);
const EvidenceLessonIdsSchema = z.array(LessonIdSchema).max(50);
const EvidenceBaseShape = {
  observation_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
      "observation_id must use letters, numbers, dot, underscore, colon, or hyphen",
    ),
  task_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
      "task_id must use letters, numbers, dot, underscore, colon, or hyphen",
    ),
  client: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "client must be lowercase kebab-case"),
  sample_kind: EvidenceSampleKindSchema,
  observed_catalog_hash: Sha256Schema,
  reason: EvidenceTextSchema,
};

const EvidenceRecordShape = {
  version: z.literal("0.1.0"),
  event_id: z.string().uuid(),
  recorded_at: z.string().datetime(),
};

export const RetrieveObservationInputSchema = z
  .object({
    type: z.literal("retrieve_observation"),
    ...EvidenceBaseShape,
    returned_lesson_ids: EvidenceLessonIdsSchema,
    used_lesson_ids: EvidenceLessonIdsSchema,
    irrelevant_lesson_ids: EvidenceLessonIdsSchema,
    missed_existing_lesson_ids: EvidenceLessonIdsSchema,
    coverage_gap: z.boolean(),
  })
  .strict();

export const DetectorObservationInputSchema = z
  .object({
    type: z.literal("detector_observation"),
    ...EvidenceBaseShape,
    lesson_id: LessonIdSchema,
    target: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          !path.posix.isAbsolute(value) &&
          !path.win32.isAbsolute(value) &&
          !value.split(/[\\/]/).includes("..") &&
          !value.startsWith("~") &&
          !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
          !/[\r\n]/.test(value) &&
          !value.includes("\0"),
        "target must be a relative path or opaque reference without parent traversal",
      ),
    classification: DetectorClassificationSchema,
    gate_pressure: z.boolean(),
  })
  .strict();

export const EvidenceInputSchema = z.discriminatedUnion("type", [
  RetrieveObservationInputSchema,
  DetectorObservationInputSchema,
]);

export const RetrieveObservationSchema = RetrieveObservationInputSchema.extend({
  ...EvidenceRecordShape,
});

export const DetectorObservationSchema = DetectorObservationInputSchema.extend({
  ...EvidenceRecordShape,
});

export const EvidenceEventSchema = z.discriminatedUnion("type", [
  RetrieveObservationSchema,
  DetectorObservationSchema,
]);

export type EvidenceSampleKind = z.infer<typeof EvidenceSampleKindSchema>;
export type DetectorClassification = z.infer<
  typeof DetectorClassificationSchema
>;
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
export type RetrieveObservationInput = z.infer<
  typeof RetrieveObservationInputSchema
>;
export type DetectorObservationInput = z.infer<
  typeof DetectorObservationInputSchema
>;
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type RetrieveObservation = z.infer<typeof RetrieveObservationSchema>;
export type DetectorObservation = z.infer<typeof DetectorObservationSchema>;

export const ManifestSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().default(""),
    visibility: VisibilitySchema.default("private"),
    version: SemverSchema.default("0.1.0"),
    dependencies: z.record(PackNameSchema, SemverRangeSchema).default({}),
    // New lessons must always enter the human decision queue. Lifecycle states
    // are transitions, not manifest-configurable defaults.
    default_status_for_new: z.literal("candidate").default("candidate"),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.visibility === "public" &&
      !PackNameSchema.safeParse(manifest.name).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "public pack name must use lowercase path segments",
      });
    }
  });

export type Manifest = z.infer<typeof ManifestSchema>;

export function validateLesson(input: unknown): Lesson {
  return LessonSchema.parse(input);
}

export function validateManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

export function validateReviewSubmission(input: unknown): ReviewSubmission {
  return ReviewSubmissionSchema.parse(input);
}

export function validateReviewEnvelope(input: unknown): ReviewEnvelope {
  return ReviewEnvelopeSchema.parse(input);
}

export function validateCandidateReview(input: unknown): CandidateReview {
  return CandidateReviewSchema.parse(input);
}

export function validateEvidenceInput(input: unknown): EvidenceInput {
  return EvidenceInputSchema.parse(input);
}

export function validateEvidenceEvent(input: unknown): EvidenceEvent {
  return EvidenceEventSchema.parse(input);
}

/** Fields that must not appear in public lessons (soft check on string content). */
const SENSITIVE_HINTS =
  /(?:\bsk-[a-z0-9_-]{10,}\b|\bgh[pousr]_[a-z0-9]{20,}\b|\bgithub_pat_[a-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bapi[_-]?key["']?\s*[:=]|\bpassword["']?\s*[:=]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|@internal\.|(?:corp\.local|[a-z0-9.-]+\.internal)\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+))/i;
const EMAIL_HINT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const LOCAL_PATH_HINT = /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Z]:\\Users\\[^\\\s"']+)/i;
const PROMPT_INJECTION_HINT =
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions|\breveal\s+(?:the\s+)?system\s+prompt|\bsend\s+(?:secrets|credentials)\s+to\b/i;

export function findSensitiveContentIssues(lesson: Lesson): string[] {
  return findSensitiveValueIssues(lesson, "lesson");
}

/** Scan bounded pre-distillation input before it can cross a provider boundary. */
export function findSensitiveInputIssues(input: unknown): string[] {
  return findSensitiveValueIssues(input, "input");
}

function findSensitiveValueIssues(input: unknown, label: "lesson" | "input"): string[] {
  const blob = JSON.stringify(input);
  const issues: string[] = [];
  if (SENSITIVE_HINTS.test(blob)) {
    issues.push(`${label} may contain secrets or internal hostnames`);
  }
  if (EMAIL_HINT.test(blob)) {
    issues.push(`${label} may contain an email address or PII`);
  }
  if (LOCAL_PATH_HINT.test(blob)) {
    issues.push(`${label} may contain a user-specific absolute path`);
  }
  if (PROMPT_INJECTION_HINT.test(blob)) {
    issues.push(`${label} may contain prompt-injection instructions`);
  }
  if (blob.length > 12_000) {
    issues.push(`${label} is unusually large; prefer abstract patterns only`);
  }
  return issues;
}

export function assertPublicSafe(lesson: Lesson): string[] {
  if (lesson.visibility !== "public") return [];
  return findSensitiveContentIssues(lesson);
}
