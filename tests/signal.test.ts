import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { distillHeuristic } from "../src/distill.js";
import {
  distillFixSignal,
  fixSignalFromCi,
  fixSignalFromSentryResolved,
  ingestFixSignal,
  type FixSignal,
} from "../src/signal.js";
import { initLore, loadStore } from "../src/store.js";

describe("privacy-safe CI and Sentry fix-signal bridge", () => {
  it("idempotently distills a resolved signal into a private candidate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-signal-"));
    try {
      initLore(root, { name: "test/signals", copySeed: false });
      const signal = fixSignal();
      const distiller = async (input: Parameters<typeof distillHeuristic>[0]) =>
        distillHeuristic(input);
      const first = await ingestFixSignal(root, signal, distiller);
      expect(first).toMatchObject({ created: true });
      expect(first.lesson).toMatchObject({
        status: "candidate",
        visibility: "private",
        tags: expect.arrayContaining(["external-fix-signal", "generic-ci"]),
      });
      expect(first.lesson.sources.references[0]).toMatch(
        /^signal:generic-ci:[a-f0-9]{20}:[a-f0-9]{64}$/,
      );

      const duplicate = await ingestFixSignal(root, signal, distiller);
      expect(duplicate).toMatchObject({ created: false });
      expect(loadStore(root).lessons).toHaveLength(1);
      await expect(
        ingestFixSignal(
          root,
          { ...signal, description: "A different normalized failure" },
          distiller,
        ),
      ).rejects.toThrow("event id was reused");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects raw logs and sensitive abstractions before writing a candidate", async () => {
    await expect(
      distillFixSignal({ ...fixSignal(), description: "failure\n    at raw-stack.ts:1" }),
    ).rejects.toThrow("one abstract line");
    await expect(
      distillFixSignal({
        ...fixSignal(),
        description: "Request used api_key=super-secret-value",
      }),
    ).rejects.toThrow("must be abstract");
    await expect(
      distillFixSignal({
        ...fixSignal(),
        description: "Failure affected person@example.com",
      }),
    ).rejects.toThrow("must be abstract");

    let distillerCalled = false;
    await expect(
      distillFixSignal(
        {
          ...fixSignal(),
          fix_summary: "The repair removed api_key=synthetic-sensitive-value",
        },
        async (input) => {
          distillerCalled = true;
          return distillHeuristic(input);
        },
      ),
    ).rejects.toThrow("must be abstract before distillation");
    expect(distillerCalled).toBe(false);
  });

  it("derives bounded CI ids and discards raw Sentry payload data", () => {
    const ci = fixSignalFromCi(
      {
        description: "The retry path accepted stale state",
        fixSummary: "Compare the generation before retrying",
        languages: ["typescript"],
      },
      {
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_JOB: "test",
      },
    );
    expect(ci).toMatchObject({
      provider: "github-actions",
      event_id: "123:2:test",
      resolution: "fixed",
    });

    const sentry = fixSignalFromSentryResolved(
      {
        action: "resolved",
        data: {
          issue: {
            id: "987",
            title: "person@example.com /Users/alice/private.ts",
            metadata: { stacktrace: "raw private stack" },
          },
        },
      },
      {
        description: "A stale cache survived the invalidation boundary",
        fixSummary: "Invalidate the cache in the same transaction",
        languages: ["typescript"],
      },
    );
    expect(sentry).toMatchObject({ provider: "sentry", event_id: "987" });
    expect(JSON.stringify(sentry)).not.toContain("person@example.com");
    expect(() =>
      fixSignalFromSentryResolved(
        { action: "created", data: { issue: { id: "987" } } },
        {
          description: "A stale cache survived the invalidation boundary",
          fixSummary: "Invalidate the cache in the same transaction",
          languages: ["typescript"],
        },
      ),
    ).toThrow();
  });

  it("coalesces concurrent retries of the same normalized signal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-signal-race-"));
    try {
      initLore(root, { name: "test/signal-race", copySeed: false });
      let waiting = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const distiller = async (input: Parameters<typeof distillHeuristic>[0]) => {
        waiting += 1;
        if (waiting === 2) release();
        await gate;
        return distillHeuristic(input);
      };
      const results = await Promise.all([
        ingestFixSignal(root, fixSignal(), distiller),
        ingestFixSignal(root, fixSignal(), distiller),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(loadStore(root).lessons).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixSignal(): FixSignal {
  return {
    version: "0.1.0",
    provider: "generic-ci",
    event_id: "pipeline-123:job-test",
    resolution: "fixed",
    description: "The retry path accepted stale state",
    fix_summary: "Compare the generation before retrying",
    languages: ["typescript"],
    ecosystems: ["node"],
  };
}
