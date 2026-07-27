import type { Lesson } from "./schema.js";
import type { RankedLesson } from "./retrieve.js";
import { formatLessonsForPrompt } from "./retrieve.js";

export function exportAgentsSnippet(lessons: Lesson[]): string {
  const lines = [
    "## PitLore constraints",
    "",
    "Respect these executable lessons while writing code:",
    "",
  ];
  for (const l of lessons.filter((x) => x.status === "approved")) {
    lines.push(`- **${l.id}** (${l.severity}): ${l.forbid_pattern_abstract}`);
    lines.push(`  Prefer: ${l.safe_pattern_abstract}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function exportPromptFromRanked(ranked: RankedLesson[]): string {
  return formatLessonsForPrompt(
    ranked.filter(({ lesson }) => lesson.status === "approved"),
  );
}
