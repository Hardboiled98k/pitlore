import { minimatch } from "minimatch";
import type { Lesson } from "./schema.js";
import { lessonSearchBlob, type LoreStore } from "./store.js";

export interface RetrieveContext {
  intent?: string;
  files?: string[];
  languages?: string[];
  includeCandidate?: boolean;
  k?: number;
}

export interface RankedLesson {
  lesson: Lesson;
  score: number;
  reasons: string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "using",
  "when",
  "with",
  "without",
]);

const TEXT_QUERY_COVERAGE_FLOOR = 0.6;

function tokenize(text: string): string[] {
  return Array.from(
    new Set(text.toLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? []),
  ).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokenizeSignalTerms(text: string): string[] {
  return Array.from(
    new Set(text.toLowerCase().match(/[\p{L}\p{N}_+#]+/gu) ?? []),
  ).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function lexicalKey(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  } else if (
    token.length > 4 &&
    token.endsWith("s") &&
    !token.endsWith("ss")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function textTokenMatches(token: string, blobTokens: Set<string>): boolean {
  const key = lexicalKey(token);
  return [...blobTokens].some((blobToken) => lexicalKey(blobToken) === key);
}

function signalMatches(signal: string, contextTokens: Set<string>): boolean {
  const signalTokens = tokenizeSignalTerms(signal);
  return (
    signalTokens.length > 0 &&
    signalTokens.every((token) => contextTokens.has(token))
  );
}

function pathMatches(lesson: Lesson, files: string[]): boolean {
  const globs = lesson.scope.paths ?? [];
  if (globs.length === 0) return false;
  return files.some((file) => {
    const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
    return globs.some((glob) => {
      const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
      if (minimatch(normalizedFile, normalizedGlob, { dot: true })) return true;
      return (
        !normalizedGlob.startsWith("/") &&
        minimatch(normalizedFile, `**/${normalizedGlob}`, { dot: true })
      );
    });
  });
}

export function rankLessons(
  store: LoreStore,
  ctx: RetrieveContext,
): RankedLesson[] {
  const k = ctx.k ?? 5;
  const includeCandidate = ctx.includeCandidate ?? false;
  const intentTokens = tokenize(ctx.intent ?? "");
  const files = ctx.files ?? [];
  const fileBlob = files.join(" ").toLowerCase();
  const intentSignalTokens = new Set(tokenizeSignalTerms(ctx.intent ?? ""));
  const fileSignalTokens = new Set(tokenizeSignalTerms(fileBlob));
  const contextSignalTokens = new Set([
    ...intentSignalTokens,
    ...fileSignalTokens,
  ]);
  const langs = (ctx.languages ?? []).map((l) => l.toLowerCase());
  const hasSemanticContext = intentTokens.length > 0 || files.length > 0;

  const ranked: RankedLesson[] = [];

  for (const lesson of store.lessons) {
    const consumable =
      lesson.status === "approved" ||
      (includeCandidate && lesson.status === "candidate");
    if (!consumable) continue;

    const scoped = (lesson.scope.paths ?? []).length > 0;
    const scopeMatch = scoped && files.length > 0 && pathMatches(lesson, files);
    if (scoped && !scopeMatch) continue;

    let score = 0;
    let relevance = 0;
    let languageMatch = false;
    const reasons: string[] = [];

    // Baseline: approved + confidence
    if (lesson.status === "approved") {
      score += 2;
      reasons.push("approved");
    }
    score += lesson.confidence;
    if (lesson.severity === "block") {
      score += 0.5;
      reasons.push("block-severity");
    }

    if (langs.length > 0) {
      const hit = lesson.languages.some((l) => langs.includes(l.toLowerCase()));
      if (hit) {
        languageMatch = true;
        score += 3;
        reasons.push("language-match");
      } else {
        score -= 1;
      }
    }

    if (scopeMatch) {
      score += 4;
      relevance += 4;
      reasons.push("path-scope");
    }

    const blobTokens = new Set(tokenize(lessonSearchBlob(lesson)));
    let tokenHits = 0;
    for (const t of intentTokens) {
      if (textTokenMatches(t, blobTokens)) tokenHits += 1;
    }
    if (tokenHits > 0) {
      const tokenScore = Math.min(4, tokenHits * 0.8);
      score += tokenScore;
      const tokenCoverage = tokenHits / intentTokens.length;
      // Incidental body words from a longer task are too weak by themselves.
      // Focused queries or broad lexical coverage remain relevant; explicit
      // path, ecosystem, and tag signals can independently clear the floor.
      const textRelevant =
        tokenHits >= 2 && tokenCoverage >= TEXT_QUERY_COVERAGE_FLOOR;
      if (intentTokens.length === 1 || textRelevant) {
        relevance += tokenScore;
      }
      reasons.push(`intent-tokens:${tokenHits}`);
      if (textRelevant) {
        reasons.push(`intent-coverage:${tokenCoverage.toFixed(2)}`);
      }
    }

    // file path keywords (e.g. auth, react)
    for (const eco of lesson.ecosystems) {
      if (signalMatches(eco, fileSignalTokens)) {
        score += 1.5;
        relevance += 1.5;
        reasons.push(`ecosystem:${eco}`);
      }
    }
    for (const tag of lesson.tags) {
      if (signalMatches(tag, contextSignalTokens)) {
        score += 0.8;
        relevance += 0.8;
        reasons.push(`tag:${tag}`);
      }
    }

    // Approval/confidence determines ordering, not contextual relevance. Without
    // this floor every approved lesson appears even when nothing matches.
    if (hasSemanticContext && relevance < 0.8) continue;
    if (!hasSemanticContext && langs.length > 0 && !languageMatch) continue;

    if (score > 0.5) {
      ranked.push({ lesson, score, reasons });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, k);
}

export function formatLessonsForPrompt(ranked: RankedLesson[]): string {
  const approved = ranked.filter(({ lesson }) => lesson.status === "approved");
  if (approved.length === 0) {
    return "No PitLore lessons matched this context.";
  }
  const lines = [
    "PitLore — lessons to respect while coding (do not repeat these pits):",
    "",
  ];
  for (const { lesson, score, reasons } of approved) {
    lines.push(
      `## [${lesson.severity.toUpperCase()}] ${lesson.id} — ${lesson.title}`,
    );
    lines.push(`Score: ${score.toFixed(2)} (${reasons.join(", ")})`);
    lines.push(`Forbidden: ${lesson.forbid_pattern_abstract}`);
    lines.push(`Prefer: ${lesson.safe_pattern_abstract}`);
    lines.push(`Why: ${lesson.root_cause}`);
    if (lesson.enforcement.test_idea) {
      lines.push(`Test idea: ${lesson.enforcement.test_idea}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
