import { minimatch } from "minimatch";
import safeRegex from "safe-regex2";
import type { Lesson } from "./schema.js";
import type { LoreStore } from "./store.js";

export interface Finding {
  lessonId: string;
  title: string;
  severity: Lesson["severity"];
  message: string;
  pattern: string;
  safePattern: string;
  line?: number;
}

export type CheckConfigurationError =
  | {
      kind: "invalid-detector-regex";
      lessonId: string;
      title: string;
      pattern: string;
      message: string;
    }
  | {
      kind: "unsafe-detector-regex";
      lessonId: string;
      title: string;
      pattern: string;
      message: string;
    }
  | {
      kind: "invalid-lesson";
      filePath: string;
      message: string;
    };

export interface CheckResult {
  findings: Finding[];
  configurationErrors: CheckConfigurationError[];
  clean: boolean;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function lessonAppliesToFile(
  lesson: Lesson,
  filePath: string | undefined,
): boolean {
  const scopes = lesson.scope.paths ?? [];
  if (scopes.length === 0) return true;

  // Fail closed when the caller cannot provide a path: skipping scoped lessons
  // would let stdin or an MCP client accidentally bypass their detectors.
  if (!filePath) return true;

  const normalizedFile = normalizePath(filePath);
  return scopes.some((scope) => {
    const normalizedScope = normalizePath(scope);
    if (minimatch(normalizedFile, normalizedScope, { dot: true })) return true;

    // CLI/MCP callers may provide absolute paths while lesson scopes are normally
    // project-relative. Match the same relative suffix without weakening an
    // explicitly absolute scope.
    return (
      !normalizedScope.startsWith("/") &&
      minimatch(normalizedFile, `**/${normalizedScope}`, { dot: true })
    );
  });
}

/**
 * Heuristic pattern check against lesson.enforcement.patterns (JS regex strings).
 * MVP: lightweight, no full AST. Patterns should be written carefully.
 */
export function checkContent(
  store: LoreStore,
  content: string,
  options: { filePath?: string; onlyApproved?: boolean } = {},
): CheckResult {
  const onlyApproved = options.onlyApproved ?? true;
  const findings: Finding[] = [];
  const configurationErrors: CheckConfigurationError[] = store.loadErrors.map(
    (error) => ({
      kind: "invalid-lesson",
      filePath: error.filePath,
      message: error.message,
    }),
  );
  const lines = content.split(/\r?\n/);

  for (const lesson of store.lessons) {
    const consumable =
      lesson.status === "approved" ||
      (!onlyApproved && lesson.status === "candidate");
    if (!consumable) continue;

    const patterns = lesson.enforcement.patterns ?? [];
    const compiled: { source: string; regex: RegExp }[] = [];
    for (const source of patterns) {
      try {
        const regex = new RegExp(source, "m");
        if (!safeRegex(regex, { limit: 25 })) {
          configurationErrors.push({
            kind: "unsafe-detector-regex",
            lessonId: lesson.id,
            title: lesson.title,
            pattern: source,
            message: "pattern may exhibit catastrophic backtracking",
          });
          continue;
        }
        compiled.push({ source, regex });
      } catch (error) {
        configurationErrors.push({
          kind: "invalid-detector-regex",
          lessonId: lesson.id,
          title: lesson.title,
          pattern: source,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Detector syntax is store configuration and must fail closed even when the
    // current file is outside this lesson's scope.
    if (!lessonAppliesToFile(lesson, options.filePath)) continue;

    for (const { source, regex: re } of compiled) {
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          findings.push({
            lessonId: lesson.id,
            title: lesson.title,
            severity: lesson.severity,
            message: lesson.symptom,
            pattern: source,
            safePattern: lesson.safe_pattern_abstract,
            line: i + 1,
          });
          break; // one hit per pattern per lesson
        }
      }
      // also multi-line search
      if (!findings.some((f) => f.lessonId === lesson.id && f.pattern === source)) {
        if (re.test(content)) {
          findings.push({
            lessonId: lesson.id,
            title: lesson.title,
            severity: lesson.severity,
            message: lesson.symptom,
            pattern: source,
            safePattern: lesson.safe_pattern_abstract,
          });
        }
      }
    }
  }

  return {
    findings,
    configurationErrors,
    clean: findings.length === 0 && configurationErrors.length === 0,
  };
}

export function formatFindings(result: CheckResult): string {
  if (result.clean) return "No PitLore findings.";
  const configurationErrors = result.configurationErrors.map(
    (error) => {
      if (error.kind === "invalid-lesson") {
        return (
          `[configuration-error] ${error.filePath}\n` +
          `  Invalid lesson: ${error.message}`
        );
      }
      return (
        `[configuration-error] ${error.lessonId}\n` +
        `  ${error.title}\n` +
        `  Invalid detector regex: ${error.pattern}\n` +
        `  ${error.message}`
      );
    },
  );
  const findings = result.findings.map(
    (f) =>
      `[${f.severity}] ${f.lessonId}${f.line ? ` @ line ${f.line}` : ""}\n` +
      `  ${f.title}\n` +
      `  ${f.message}\n` +
      `  Prefer: ${f.safePattern}`,
  );
  return [...configurationErrors, ...findings].join("\n\n");
}
