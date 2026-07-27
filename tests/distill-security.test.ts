import { afterEach, describe, expect, it, vi } from "vitest";
import { distillLesson } from "../src/distill.js";

function openAIResponse(content: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

const validModelLesson = {
  id: "auth-refresh-race",
  title: "Avoid duplicate token refreshes",
  languages: ["typescript"],
  ecosystems: ["node"],
  category: "concurrency",
  symptom: "Concurrent requests refresh the same token more than once.",
  root_cause: "Refresh work was not coordinated across concurrent requests.",
  forbid_pattern_abstract: "Starting an independent refresh in every request.",
  safe_pattern_abstract: "Share one in-flight refresh promise across requests.",
  severity: "warn",
  confidence: 0.9,
  enforcement: {
    test_idea: "Run concurrent requests and assert that refresh happens once.",
    patterns: ["refreshToken\\("],
  },
  tags: ["auth", "concurrency"],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("distillLesson OpenAI governance boundary", () => {
  it("keeps governance fields local when the model injects approved/public values", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi.fn(async () =>
      openAIResponse({
        ...validModelLesson,
        version: "9.9.9",
        severity: "block",
        status: "approved",
        visibility: "public",
        scope: { paths: ["**/*"] },
        sources: { count: 99, references: ["model-controlled"] },
        enforcement: {
          ...validModelLesson.enforcement,
          detector_ref: "model-controlled-detector",
        },
        created_at: "2000-01-01T00:00:00.000Z",
        updated_at: "2000-01-01T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const lesson = await distillLesson({
      description: "Duplicate token refreshes under concurrent requests",
      languages: ["typescript"],
      idHint: "local-candidate-id",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lesson.id).toBe("local-candidate-id");
    expect(lesson.id).not.toBe(validModelLesson.id);
    expect(lesson.status).toBe("candidate");
    expect(lesson.visibility).toBe("private");
    expect(lesson.version).toBe("0.1.0");
    expect(lesson.severity).toBe("warn");
    expect(lesson.scope).toEqual({ paths: [] });
    expect(lesson.sources).toEqual({ count: 1, references: [] });
    expect(lesson.enforcement.detector_ref).toBeNull();
    expect(lesson.created_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(lesson.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("keeps allowed model fields behind schema validation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi.fn(async () =>
      openAIResponse({
        ...validModelLesson,
        confidence: 2,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const lesson = await distillLesson({
      description: "Duplicate token refreshes under concurrent requests",
      idHint: "local-fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI distill failed"),
    );
    expect(lesson.id).toBe("local-fallback");
    expect(lesson.confidence).toBe(0.45);
    expect(lesson.status).toBe("candidate");
    expect(lesson.visibility).toBe("private");
  });

  it("falls back to a private candidate when the OpenAI request times out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason ?? new DOMException("Timed out", "TimeoutError"),
            ),
          { once: true },
        );
      });
      throw new Error("unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = distillLesson({
      description: "The model request hangs during a network failure",
      idHint: "bounded-distill-request",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort(new DOMException("Timed out", "TimeoutError"));
    const lesson = await pending;

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI distill timed out after 60000ms"),
    );
    expect(lesson.id).toBe("bounded-distill-request");
    expect(lesson.status).toBe("candidate");
    expect(lesson.visibility).toBe("private");
    expect(lesson.severity).toBe("warn");
  });
});
