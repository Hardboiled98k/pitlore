import { createHash } from "node:crypto";
import { z } from "zod";
import { distillHeuristic, type DistillInput } from "./distill.js";
import {
  findSensitiveContentIssues,
  findSensitiveInputIssues,
  validateLesson,
  type Lesson,
} from "./schema.js";
import { getLesson, loadStore, putLesson } from "./store.js";

const AbstractSignalTextSchema = z
  .string()
  .trim()
  .min(3)
  .max(600)
  .refine(
    (value) => !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "signal text must be one abstract line without logs or control characters",
  );

const SignalLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9+#._-]*$/);

export const FixSignalSchema = z
  .object({
    version: z.literal("0.1.0"),
    provider: z.enum(["github-actions", "generic-ci", "sentry"]),
    event_id: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        "signal event id contains control characters",
      ),
    resolution: z.literal("fixed"),
    description: AbstractSignalTextSchema,
    fix_summary: AbstractSignalTextSchema,
    languages: z.array(SignalLabelSchema).min(1).max(12),
    ecosystems: z.array(SignalLabelSchema).max(12).default([]),
  })
  .strict();

export type FixSignal = z.infer<typeof FixSignalSchema>;

export interface SignalIngestResult {
  readonly lesson: Lesson;
  readonly created: boolean;
  readonly file?: string;
}

type SignalDistiller = (input: DistillInput) => Promise<Lesson>;

const localSignalDistiller: SignalDistiller = async (input) =>
  distillHeuristic(input);

export async function distillFixSignal(
  input: unknown,
  distiller: SignalDistiller = localSignalDistiller,
): Promise<Lesson> {
  const signal = FixSignalSchema.parse(input);
  const identity = signalIdentity(signal);
  const inputIssues = findSensitiveInputIssues({
    description: signal.description,
    fix_summary: signal.fix_summary,
  });
  if (inputIssues.length > 0) {
    throw new Error(
      `Fix signal must be abstract before distillation: ${inputIssues.join("; ")}`,
    );
  }
  const draft = await distiller({
    description: signal.description,
    diffSummary: signal.fix_summary,
    languages: signal.languages,
    ecosystems: signal.ecosystems,
    idHint: identity.lessonId,
  });
  const lesson = validateLesson({
    ...draft,
    id: identity.lessonId,
    status: "candidate",
    visibility: "private",
    sources: { count: 1, references: [identity.reference] },
    tags: [...new Set([...draft.tags, "external-fix-signal", signal.provider])],
  });
  const issues = findSensitiveContentIssues(lesson);
  if (issues.length > 0) {
    throw new Error(
      `Fix signal must be abstract before distillation: ${issues.join("; ")}`,
    );
  }
  return lesson;
}

export async function ingestFixSignal(
  loreRoot: string,
  input: unknown,
  distiller: SignalDistiller = localSignalDistiller,
): Promise<SignalIngestResult> {
  const signal = FixSignalSchema.parse(input);
  const identity = signalIdentity(signal);
  const store = loadStore(loreRoot);
  const existing = getLesson(store, identity.lessonId);
  if (existing) {
    if (!existing.sources.references.includes(identity.reference)) {
      throw new Error(
        "Fix signal event id was reused with different normalized content",
      );
    }
    return { lesson: existing, created: false };
  }
  const lesson = await distillFixSignal(signal, distiller);
  try {
    const file = putLesson(loreRoot, lesson, { overwrite: false });
    return { lesson, file, created: true };
  } catch (error) {
    const concurrent = getLesson(loadStore(loreRoot), identity.lessonId);
    if (concurrent?.sources.references.includes(identity.reference)) {
      return { lesson: concurrent, created: false };
    }
    throw error;
  }
}

export interface CiFixSignalInput {
  readonly eventId?: string;
  readonly description: string;
  readonly fixSummary: string;
  readonly languages: readonly string[];
  readonly ecosystems?: readonly string[];
}

/** Convert bounded CI metadata plus operator-written abstractions into a fix signal. */
export function fixSignalFromCi(
  input: CiFixSignalInput,
  env: NodeJS.ProcessEnv = process.env,
): FixSignal {
  const github = env.GITHUB_ACTIONS === "true";
  const eventId = input.eventId ?? (github
    ? requiredParts(
        [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT ?? "1", env.GITHUB_JOB],
        "GitHub Actions run id, attempt, and job",
      ).join(":")
    : requiredParts(
        [env.CI_PIPELINE_ID, env.CI_JOB_ID],
        "generic CI pipeline and job ids (or pass --event-id)",
      ).join(":"));
  return FixSignalSchema.parse({
    version: "0.1.0",
    provider: github ? "github-actions" : "generic-ci",
    event_id: eventId,
    resolution: "fixed",
    description: input.description,
    fix_summary: input.fixSummary,
    languages: [...input.languages],
    ecosystems: [...(input.ecosystems ?? [])],
  });
}

const SentryResolvedWebhookSchema = z
  .object({
    action: z.literal("resolved"),
    data: z
      .object({
        issue: z
          .object({ id: z.union([z.string(), z.number().int().nonnegative()]) })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Extract only the issue id and resolved action from a Sentry webhook. Raw
 * title, stack, tags, request data, and user data are deliberately discarded.
 */
export function fixSignalFromSentryResolved(
  webhook: unknown,
  input: Omit<CiFixSignalInput, "eventId">,
): FixSignal {
  const parsed = SentryResolvedWebhookSchema.parse(webhook);
  return FixSignalSchema.parse({
    version: "0.1.0",
    provider: "sentry",
    event_id: String(parsed.data.issue.id),
    resolution: "fixed",
    description: input.description,
    fix_summary: input.fixSummary,
    languages: [...input.languages],
    ecosystems: [...(input.ecosystems ?? [])],
  });
}

function signalIdentity(signal: FixSignal): {
  lessonId: string;
  reference: string;
} {
  const eventDigest = createHash("sha256")
    .update(`${signal.provider}\0${signal.event_id}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  const contentDigest = createHash("sha256")
    .update(JSON.stringify(signal), "utf8")
    .digest("hex");
  return {
    lessonId: `signal-${signal.provider}-${eventDigest}`,
    reference: `signal:${signal.provider}:${eventDigest}:${contentDigest}`,
  };
}

function requiredParts(
  values: readonly (string | undefined)[],
  label: string,
): string[] {
  if (values.some((value) => !value || value.trim() === "")) {
    throw new Error(`Missing ${label}`);
  }
  return values.map((value) => value!.trim());
}
