import { createHash } from "node:crypto";
import { validateLesson, type Lesson } from "./schema.js";

export interface DistillInput {
  description: string;
  languages?: string[];
  ecosystems?: string[];
  diffSummary?: string;
  idHint?: string;
}

const HEURISTIC_TITLE_MAX_LENGTH = 80;
const OPENAI_DISTILL_TIMEOUT_MS = 60_000;

function heuristicTitle(description: string, idHint?: string): string {
  const normalized = description.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= HEURISTIC_TITLE_MAX_LENGTH) return normalized;

  const visible = characters.slice(0, HEURISTIC_TITLE_MAX_LENGTH);
  for (let index = 11; index < visible.length; index += 1) {
    const character = visible[index];
    const next = characters[index + 1];
    const isCjkBoundary = "。！？；".includes(character);
    const isAsciiBoundary =
      ".!?;".includes(character) &&
      (next === undefined || /\s/u.test(next));
    if (isCjkBoundary || isAsciiBoundary) {
      return visible
        .slice(0, index + 1)
        .join("")
        .replace(/[.!?。！？;；]+$/u, "")
        .trim();
    }
  }

  const hintedId = idHint ? slugify(idHint) : "";
  if (hintedId.length >= 3) {
    const humanized = hintedId.replace(/-/gu, " ");
    return `${humanized[0].toUpperCase()}${humanized.slice(1)}`;
  }

  const prefix = visible.slice(0, HEURISTIC_TITLE_MAX_LENGTH - 1).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  const wordBoundary = Math.floor(HEURISTIC_TITLE_MAX_LENGTH * 0.6);
  const readablePrefix = lastSpace >= wordBoundary
    ? prefix.slice(0, lastSpace)
    : prefix;
  return `${readablePrefix.trimEnd()}…`;
}

/**
 * Offline/heuristic distill — always works without API keys.
 * Optional OpenAI path when OPENAI_API_KEY is set (GPT-5.6 / configurable model).
 */
export async function distillLesson(input: DistillInput): Promise<Lesson> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      return await distillWithOpenAI(input, apiKey);
    } catch (err) {
      const timedOut =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      const outcome = timedOut
        ? `timed out after ${OPENAI_DISTILL_TIMEOUT_MS}ms`
        : "failed";
      console.warn(
        `OpenAI distill ${outcome}, falling back to local heuristic: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return distillHeuristic(input);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

function localLessonId(input: DistillInput): string {
  const hint = input.idHint ? slugify(input.idHint) : "";
  if (hint.length >= 3) return hint;

  const description = input.description.trim();
  const readable = slugify(description).slice(0, 32) || "item";
  const digest = createHash("sha256")
    .update(description)
    .digest("hex")
    .slice(0, 8);
  return `lesson-${readable}-${digest}`;
}

export function distillHeuristic(input: DistillInput): Lesson {
  const desc = input.description.trim();
  const id = localLessonId(input);
  const languages = input.languages?.length ? input.languages : ["typescript"];
  const now = new Date().toISOString();

  return validateLesson({
    id,
    version: "0.1.0",
    title: heuristicTitle(desc, input.idHint),
    languages,
    ecosystems: input.ecosystems ?? [],
    category: "general",
    symptom: desc,
    root_cause: input.diffSummary
      ? `Inferred from fix signal: ${input.diffSummary.slice(0, 400)}`
      : "Needs human refinement — auto-distilled from description only.",
    forbid_pattern_abstract: `Repeating the failure mode described as: ${desc}`,
    safe_pattern_abstract:
      "Apply the corrected approach from the fix; add a regression test before closing.",
    scope: { paths: [] },
    severity: "warn",
    confidence: 0.45,
    sources: { count: 1, references: [] },
    enforcement: {
      test_idea: `Add a regression test that fails on: ${desc.slice(0, 120)}`,
      detector_ref: null,
      patterns: [],
    },
    tags: ["auto-distilled"],
    status: "candidate",
    visibility: "private",
    created_at: now,
    updated_at: now,
  });
}

async function distillWithOpenAI(
  input: DistillInput,
  apiKey: string,
): Promise<Lesson> {
  const model = process.env.PITLORE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6";
  const system = `You distill bug-fix experience into a PitLore Lesson JSON object.
Return ONLY valid JSON matching this shape:
{
  "id": "kebab-case-id",
  "title": "short title",
  "languages": ["typescript"],
  "ecosystems": [],
  "category": "concurrency|security|api|data|general|...",
  "symptom": "...",
  "root_cause": "abstract, no secrets/business code",
  "forbid_pattern_abstract": "...",
  "safe_pattern_abstract": "...",
  "severity": "info|warn|block",
  "confidence": 0.0-1.0,
  "enforcement": { "test_idea": "...", "patterns": ["regex..."] },
  "tags": []
}
No source code dumps. Prefer abstract anti-patterns. patterns are optional JS regex strings for heuristic detection.`;

  const user = JSON.stringify({
    description: input.description,
    languages: input.languages,
    ecosystems: input.ecosystems,
    diffSummary: input.diffSummary,
    idHint: input.idHint,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(OPENAI_DISTILL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response");

  const parsed = JSON.parse(content) as Record<string, unknown>;
  const modelFields: Record<string, unknown> = {};
  const allowedModelFields = [
    "title",
    "languages",
    "ecosystems",
    "category",
    "symptom",
    "root_cause",
    "forbid_pattern_abstract",
    "safe_pattern_abstract",
    "confidence",
    "enforcement",
    "tags",
  ] as const;

  for (const field of allowedModelFields) {
    if (Object.hasOwn(parsed, field)) {
      modelFields[field] = parsed[field];
    }
  }

  const enforcement = modelFields.enforcement;
  if (
    typeof enforcement === "object" &&
    enforcement !== null &&
    !Array.isArray(enforcement)
  ) {
    const enforcementRecord = enforcement as Record<string, unknown>;
    const allowedEnforcement: Record<string, unknown> = {};
    for (const field of ["test_idea", "patterns"] as const) {
      if (Object.hasOwn(enforcementRecord, field)) {
        allowedEnforcement[field] = enforcementRecord[field];
      }
    }
    modelFields.enforcement = allowedEnforcement;
  }

  const now = new Date().toISOString();
  return validateLesson({
    ecosystems: input.ecosystems ?? [],
    languages: input.languages ?? ["typescript"],
    ...modelFields,
    // Identity is local governance state. A model-selected id could overwrite an
    // existing approved lesson when the candidate is persisted.
    id: localLessonId(input),
    version: "0.1.0",
    severity: "warn",
    status: "candidate",
    visibility: "private",
    scope: { paths: [] },
    sources: { count: 1, references: [] },
    created_at: now,
    updated_at: now,
  });
}
