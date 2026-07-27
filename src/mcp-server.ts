import { z } from "zod";
import { checkContent, formatFindings } from "./check.js";
import { distillLesson } from "./distill.js";
import { exportPromptFromRanked } from "./export.js";
import { loadEffectiveStore } from "./pack.js";
import { resolveLoreRoot } from "./paths.js";
import { formatLessonsForPrompt, rankLessons } from "./retrieve.js";
import { buildReviewPacket, recordCandidateReview } from "./review.js";
import { ReviewEnvelopeSchema } from "./schema.js";
import { McpServer, StdioServerTransport } from "./mcp-runtime.js";
import {
  approvedCatalogHash,
  ensureWritableLoreRoot,
  getLesson,
  listLessons,
  loadStore,
  putLesson,
} from "./store.js";
import { PACKAGE_VERSION } from "./version.js";

export interface PitLoreMcpServer {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export function createMcpServer(
  loreRoot?: string,
  cwd = process.cwd(),
): PitLoreMcpServer {
  const server = new McpServer({
    name: "pitlore",
    version: PACKAGE_VERSION,
  });

  let activeRoot = loreRoot && loreRoot.trim().length > 0 ? loreRoot : undefined;
  const root = () => activeRoot ?? resolveLoreRoot(cwd);
  const writableRoot = () => {
    activeRoot = ensureWritableLoreRoot(root(), { cwd });
    return activeRoot;
  };

  server.tool(
    "pitlore_search",
    "Search PitLore lessons by free text, language, or status",
    {
      query: z.string().optional().describe("Free-text search"),
      language: z.string().optional(),
      status: z
        .enum(["candidate", "approved", "rejected", "deprecated", "all"])
        .optional()
        .default("approved"),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ query, language, status, limit }) => {
      const store =
        status === "approved" || status === "all"
          ? loadEffectiveStore(root())
          : loadStore(root());
      const items = listLessons(store, {
        q: query,
        language,
        status: status ?? "approved",
      }).slice(0, limit ?? 10);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              items.map((l) => ({
                id: l.id,
                title: l.title,
                severity: l.severity,
                status: l.status,
                languages: l.languages,
                forbid: l.forbid_pattern_abstract,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_retrieve",
    "Retrieve Top-K approved lessons for the current coding task and return an injectable prompt block",
    {
      intent: z.string().optional().describe("What you are about to implement"),
      files: z
        .array(z.string())
        .optional()
        .describe("Files being edited (paths)"),
      languages: z.array(z.string()).optional(),
      k: z.number().int().min(1).max(20).optional().default(5),
    },
    async ({ intent, files, languages, k }) => {
      const store = loadEffectiveStore(root());
      const ranked = rankLessons(store, {
        intent,
        files,
        languages,
        k,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              "PitLore evidence context (copy into a later observation):\n" +
              `observed_catalog_hash: ${approvedCatalogHash(store)}\n\n` +
              formatLessonsForPrompt(ranked),
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_get",
    "Get full detail for a single lesson by id",
    {
      id: z.string(),
    },
    async ({ id }) => {
      const store = loadEffectiveStore(root());
      const lesson = getLesson(store, id);
      if (!lesson) {
        return {
          content: [{ type: "text" as const, text: `Lesson not found: ${id}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(lesson, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_check",
    "Scan code text against approved lesson heuristic patterns; report findings",
    {
      content: z.string().describe("Source code or diff text to scan"),
      filePath: z.string().optional(),
    },
    async ({ content, filePath }) => {
      const store = loadEffectiveStore(root());
      const result = checkContent(store, content, {
        filePath,
        onlyApproved: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                observed_catalog_hash: approvedCatalogHash(store),
                clean: result.clean,
                findings: result.findings,
                configurationErrors: result.configurationErrors,
                summary: formatFindings(result),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_review",
    "Prepare or record an advisory LLM review for a private candidate; may reveal candidate content and write a review sidecar, but never approves or rejects the lesson",
    {
      id: z.string().describe("Candidate lesson id"),
      envelope: ReviewEnvelopeSchema.optional().describe(
        "Omit to receive an untrusted-data review packet; provide required_review_envelope from that packet to record the LLM review",
      ),
    },
    async ({ id, envelope }) => {
      if (!envelope) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(buildReviewPacket(root(), id), null, 2),
            },
          ],
        };
      }
      const { review } = recordCandidateReview(
        writableRoot(),
        id,
        envelope.submission,
        envelope.review_context_hash,
        { cwd },
      );
      const lesson = getLesson(loadStore(root()), id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                recorded: true,
                recommendation: review.recommendation,
                confidence: review.confidence,
                lesson_status: lesson?.status,
                human_decision_required: true,
                human_approval_required: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_remember",
    "Distill a bug/fix description into a candidate lesson and save it",
    {
      description: z.string(),
      languages: z.array(z.string()).optional(),
      ecosystems: z.array(z.string()).optional(),
      diffSummary: z.string().optional(),
      idHint: z.string().optional(),
    },
    async ({ description, languages, ecosystems, diffSummary, idHint }) => {
      const lesson = await distillLesson({
        description,
        languages,
        ecosystems,
        diffSummary,
        idHint,
      });
      const file = putLesson(writableRoot(), lesson, { overwrite: false });
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved ${lesson.status} lesson ${lesson.id} -> ${file}`,
          },
        ],
      };
    },
  );

  server.tool(
    "pitlore_export_prompt",
    "Export ranked lessons as a short constraint block for system/developer prompts",
    {
      intent: z.string().optional(),
      files: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      k: z.number().int().min(1).max(20).optional().default(5),
    },
    async ({ intent, files, languages, k }) => {
      const store = loadEffectiveStore(root());
      const ranked = rankLessons(store, { intent, files, languages, k });
      return {
        content: [
          {
            type: "text" as const,
            text: exportPromptFromRanked(ranked),
          },
        ],
      };
    },
  );

  return server as unknown as PitLoreMcpServer;
}

export async function startMcpServer(loreRoot?: string): Promise<void> {
  const server = createMcpServer(loreRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
