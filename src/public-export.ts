import { assertPublicSafe, validateLesson, type Lesson } from "./schema.js";

export interface PublicLessonDraft extends Lesson {
  visibility: "public";
}

/**
 * Prepare an explicitly selected approved Lesson for public Git export.
 * Private/local scope and non-URL source references are never exported.
 */
export function sanitizeLessonForPublic(lesson: Lesson): PublicLessonDraft {
  if (lesson.status !== "approved") {
    throw new Error(
      `Only approved lessons can be exported publicly: ${lesson.id}`,
    );
  }

  const draft = validateLesson({
    ...lesson,
    visibility: "public",
    scope: { paths: [] },
    sources: {
      references: lesson.sources.references.filter((reference) =>
        /^https?:\/\//iu.test(reference),
      ),
      count: lesson.sources.references.filter((reference) =>
        /^https?:\/\//iu.test(reference),
      ).length,
    },
  }) as PublicLessonDraft;
  const issues = assertPublicSafe(draft);
  if (issues.length > 0) {
    throw new Error(`Public export blocked: ${issues.join("; ")}`);
  }
  return draft;
}
