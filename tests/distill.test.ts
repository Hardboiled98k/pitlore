import { describe, expect, it } from "vitest";
import { distillHeuristic } from "../src/distill.js";

describe("distillHeuristic", () => {
  it("creates a candidate lesson from a description", () => {
    const lesson = distillHeuristic({
      description: "Race condition when refreshing auth tokens",
      languages: ["typescript"],
      idHint: "auth-refresh-race",
    });
    expect(lesson.id).toBe("auth-refresh-race");
    expect(lesson.status).toBe("candidate");
    expect(lesson.languages).toContain("typescript");
  });

  it("creates distinct schema-safe ids for non-Latin descriptions", () => {
    const first = distillHeuristic({ description: "修复并发刷新令牌问题" });
    const second = distillHeuristic({ description: "修复数据库连接泄漏问题" });

    expect(first.id).toMatch(/^lesson-item-[a-f0-9]{8}$/);
    expect(second.id).toMatch(/^lesson-item-[a-f0-9]{8}$/);
    expect(first.id).not.toBe(second.id);
  });

  it("stops a long title at a complete clause", () => {
    const lesson = distillHeuristic({
      description:
        "在 Codex 非交互模式中，只读 MCP 调用因审批提示被当作用户取消；修复后只读工具可以继续运行，同时写入工具仍然需要人工确认，并且这段额外说明确保输入明显超过标题长度上限。",
    });

    expect(lesson.title).toBe(
      "在 Codex 非交互模式中，只读 MCP 调用因审批提示被当作用户取消",
    );
  });

  it("adds an ellipsis without cutting an English word", () => {
    const lesson = distillHeuristic({
      description:
        "A non-interactive coding agent repeatedly requested approval for a trusted local read-only retrieval tool without providing a terminal for the operator",
    });

    expect(Array.from(lesson.title).length).toBeLessThanOrEqual(80);
    expect(lesson.title).toBe(
      "A non-interactive coding agent repeatedly requested approval for a trusted…",
    );
  });

  it("counts Unicode code points at the 80-character boundary", () => {
    const exact = distillHeuristic({ description: "🙂".repeat(80) });
    const over = distillHeuristic({ description: "🙂".repeat(81) });

    expect(exact.title).toBe("🙂".repeat(80));
    expect(Array.from(over.title)).toHaveLength(80);
    expect(over.title).toBe(`${"🙂".repeat(79)}…`);
  });

  it("keeps a short multi-sentence description unchanged", () => {
    const description = "This description is short enough. More context stays here.";

    expect(distillHeuristic({ description }).title).toBe(description);
  });

  it("normalizes whitespace in a short title", () => {
    const lesson = distillHeuristic({
      description: "  Approval prompt\n  cancelled the   read-only call  ",
    });

    expect(lesson.title).toBe("Approval prompt cancelled the read-only call");
  });

  it("does not treat the clipped window edge as end of sentence", () => {
    const lesson = distillHeuristic({
      description: `${"a".repeat(79)}.x`,
    });

    expect(lesson.title).toBe(`${"a".repeat(79)}…`);
  });

  it("uses a readable id hint when no complete clause fits", () => {
    const lesson = distillHeuristic({
      description:
        "GitHub Actions used actions/checkout@v4 and actions/setup-node@v4 after their Node runtime became outdated during a real continuous integration run",
      idHint: "github-actions-runtime-version-drift",
    });

    expect(lesson.title).toBe("Github actions runtime version drift");
  });

  it("removes a separator left at the id hint length limit", () => {
    const lesson = distillHeuristic({
      description: "A long description without a sentence boundary ".repeat(4),
      idHint: `${"a".repeat(47)}-tail`,
    });

    expect(lesson.id).toBe("a".repeat(47));
    expect(lesson.title).toBe(`A${"a".repeat(46)}`);
    expect(lesson.title.endsWith(" ")).toBe(false);
  });
});
