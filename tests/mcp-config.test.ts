import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function codexToolApproval(tool: string): string {
  const config = fs.readFileSync(path.join(repoRoot, ".codex", "config.toml"), "utf8");
  const section = config.match(
    new RegExp(
      `\\[mcp_servers\\.pitlore\\.tools\\.${tool}\\]\\s+approval_mode = "(prompt|approve)"`,
    ),
  );
  if (!section) throw new Error(`Missing Codex approval section for ${tool}`);
  return section[1]!;
}

describe("MCP project trust configuration", () => {
  it("keeps only approved-only read tools headless-approved in Codex", () => {
    expect(codexToolApproval("pitlore_retrieve")).toBe("approve");
    expect(codexToolApproval("pitlore_check")).toBe("approve");
    expect(codexToolApproval("pitlore_export_prompt")).toBe("approve");
    expect(codexToolApproval("pitlore_remember")).toBe("prompt");
    expect(codexToolApproval("pitlore_review")).toBe("prompt");
  });

  it("keeps Claude's stdio server configuration credential-free", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8"),
    ) as {
      mcpServers?: { pitlore?: { type?: string; command?: string; env?: unknown } };
    };
    expect(config.mcpServers?.pitlore?.type).toBe("stdio");
    expect(config.mcpServers?.pitlore?.command).toBe("npm");
    expect(config.mcpServers?.pitlore?.env).toEqual({});
  });
});
