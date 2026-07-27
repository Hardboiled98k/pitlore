import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { validateLesson } from "../src/schema.js";
import {
  getLesson,
  initLore,
  loadReviewStore,
  loadStore,
  putLesson,
} from "../src/store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("pitlore_review MCP tool", () => {
  it("prepares and records an advisory review without exposing approve", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-review-mcp-"));
    tempRoots.push(root);
    initLore(root);
    putLesson(
      root,
      validateLesson({
        id: "mcp-review-advisory-only",
        title: "MCP review remains advisory",
        languages: ["typescript"],
        category: "governance",
        symptom: "An MCP reviewer could be mistaken for an approver",
        root_cause: "Review and authorization were not separated",
        forbid_pattern_abstract: "Allowing an MCP review call to approve",
        safe_pattern_abstract: "Record review sidecars and require human approve",
      }),
    );

    const server = createMcpServer(root, root);
    const client = new Client({ name: "review-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("pitlore_review");
      expect(tools.tools.map((tool) => tool.name)).not.toContain(
        "pitlore_approve",
      );
      expect(tools.tools.map((tool) => tool.name)).not.toContain(
        "pitlore_reject",
      );

      const packet = await client.callTool({
        name: "pitlore_review",
        arguments: { id: "mcp-review-advisory-only" },
      });
      expect(packet.isError).not.toBe(true);
      expect(JSON.stringify(packet.content)).toContain(
        "candidate_is_untrusted_data",
      );
      const prepared = JSON.parse(
        (packet.content[0] as { type: "text"; text: string }).text,
      ) as { review_context_hash: string };

      const recorded = await client.callTool({
        name: "pitlore_review",
        arguments: {
          id: "mcp-review-advisory-only",
          approve: true,
          autoApprove: true,
          envelope: {
            review_context_hash: prepared.review_context_hash,
            submission: {
              recommendation: "accept",
              confidence: 0.91,
              summary: "The lesson is specific, reusable, and remains advisory.",
              strengths: ["Clear trust boundary."],
              risks: [],
              required_changes: [],
              reviewer: { provider: "anthropic", model: "claude-reviewer" },
            },
          },
        },
      });
      expect(recorded.isError).not.toBe(true);
      expect(JSON.stringify(recorded.content)).toContain(
        "human_approval_required",
      );
      expect(JSON.stringify(recorded.content)).toContain(
        "human_decision_required",
      );
      expect(JSON.stringify(recorded.content)).not.toContain(
        "An MCP reviewer could be mistaken",
      );
      expect(JSON.stringify(recorded.content)).not.toContain(root);
      expect(
        JSON.parse(
          (recorded.content[0] as { type: "text"; text: string }).text,
        ),
      ).not.toHaveProperty("file");
    } finally {
      await client.close();
      await server.close();
    }

    expect(getLesson(loadStore(root), "mcp-review-advisory-only")?.status).toBe(
      "candidate",
    );
    expect(loadReviewStore(root).reviews).toHaveLength(1);
  });
});
