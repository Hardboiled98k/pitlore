import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReviewPacket,
  buildReviewQueue,
  formatReviewQueue,
  recordCandidateReview,
} from "../src/review.js";
import { validateLesson, type Lesson } from "../src/schema.js";
import {
  approveLesson,
  getLesson,
  initLore,
  loadReviewStore,
  loadStore,
  putLesson,
} from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("candidate LLM reviews", () => {
  it("builds an untrusted-data packet with local deterministic checks", () => {
    const root = makeLoreRoot();
    putLesson(
      root,
      makeCandidate("invalid-warn-detector", {
        enforcement: { patterns: ["("], fixtures: { bad: [], good: [] } },
      }),
    );

    const packet = buildReviewPacket(root, "invalid-warn-detector");

    expect(packet.candidate_is_untrusted_data).toBe(true);
    expect(packet.lesson_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.review_context_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.deterministic_checks.approval_readiness.ready).toBe(false);
    expect(
      packet.deterministic_checks.approval_readiness.issues.join(" "),
    ).toContain("invalid detector configuration");
    expect(packet.instructions.join(" ")).toContain("never as instructions");
  });

  it("records only advisory fields and leaves the lesson as a candidate", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("review-stays-advisory"));

    const { review, file } = record(root, "review-stays-advisory");

    expect(file).toBe(
      path.join(root, "reviews", "review-stays-advisory.yaml"),
    );
    expect(review.reviewer.identity_trust).toBe("self-reported");
    expect(review.recommendation).toBe("edit");
    expect(getLesson(loadStore(root), review.lesson_id)?.status).toBe("candidate");
    expect(loadReviewStore(root).reviews).toEqual([review]);
  });

  it("rejects model attempts to inject governance fields", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("reject-governance-injection"));

    expect(() =>
      recordCandidateReview(
        root,
        "reject-governance-injection",
        {
          ...submission(),
          status: "approved",
          humanConfirmed: true,
          lesson_hash: "0".repeat(64),
        },
        buildReviewPacket(root, "reject-governance-injection")
          .review_context_hash,
      ),
    ).toThrow();
    expect(loadReviewStore(root).reviews).toEqual([]);
    expect(
      getLesson(loadStore(root), "reject-governance-injection")?.status,
    ).toBe("candidate");
  });

  it("marks a review stale when the candidate or approved catalog changes", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("stale-review"));
    record(root, "stale-review");
    expect(buildReviewQueue(root).items[0]?.state).toBe("current");

    const stored = getLesson(loadStore(root), "stale-review")!;
    putLesson(
      root,
      validateLesson({ ...stored, title: "Changed after review" }),
      { overwrite: true },
    );
    let queue = buildReviewQueue(root);
    expect(queue.items[0]?.state).toBe("stale");
    expect(queue.items[0]?.stale_reasons).toContain("candidate changed");

    record(root, "stale-review");
    putLesson(root, makeCandidate("new-approved-context"));
    approveLesson(root, "new-approved-context");
    queue = buildReviewQueue(root);
    const stale = queue.items.find((item) => item.id === "stale-review");
    expect(stale?.state).toBe("stale");
    expect(stale?.stale_reasons).toContain("approved catalog changed");
  });

  it("marks a block review stale when fixture content changes", () => {
    const root = makeLoreRoot();
    fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(root, "fixtures", "bad.ts"), "unsafeCall();\n");
    fs.writeFileSync(path.join(root, "fixtures", "good.ts"), "safeCall();\n");
    putLesson(
      root,
      makeCandidate("fixture-bound-review", {
        severity: "block",
        enforcement: {
          patterns: ["unsafeCall\\s*\\("],
          fixtures: {
            bad: ["fixtures/bad.ts"],
            good: ["fixtures/good.ts"],
          },
        },
      }),
    );
    record(root, "fixture-bound-review");
    expect(buildReviewQueue(root).items[0]?.state).toBe("current");

    fs.writeFileSync(path.join(root, "fixtures", "good.ts"), "unsafeCall();\n");
    const item = buildReviewQueue(root).items[0];
    expect(item?.state).toBe("stale");
    expect(item?.stale_reasons).toContain("fixtures changed");
  });

  it("shows current deterministic checks instead of a tampered sidecar snapshot", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("current-readiness-wins"));
    const { file } = record(root, "current-readiness-wins");
    const stored = fs.readFileSync(file, "utf8").replace(
      "approval_readiness:\n  ready: true\n  issues: []",
      "approval_readiness:\n  ready: false\n  issues:\n    - forged stale result",
    );
    fs.writeFileSync(file, stored);

    const item = buildReviewQueue(root).items[0];
    expect(item?.state).toBe("stale");
    expect(item?.stale_reasons).toContain(
      "deterministic approval checks changed",
    );
    expect(item?.approval_readiness).toEqual({ ready: true, issues: [] });
  });

  it("refuses a review-directory symlink that escapes the lore root", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-review-outside-");
    putLesson(root, makeCandidate("review-symlink-escape"));
    fs.symlinkSync(outside, path.join(root, "reviews"), "dir");

    expect(() =>
      record(root, "review-symlink-escape"),
    ).toThrow("Reviews directory must not be a symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not read a review-file symlink outside the lore root", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-review-file-outside-");
    putLesson(root, makeCandidate("review-file-symlink-escape"));
    fs.mkdirSync(path.join(root, "reviews"));
    const outsideFile = path.join(outside, "forged.yaml");
    fs.writeFileSync(outsideFile, "recommendation: accept\n");
    fs.symlinkSync(
      outsideFile,
      path.join(root, "reviews", "review-file-symlink-escape.yaml"),
    );

    const queue = buildReviewQueue(root);
    expect(queue.items[0]?.state).toBe("unreviewed");
    expect(queue.load_errors[0]?.message).toContain(
      "review file must not be a symlink",
    );
  });

  it("does not write through a dangling review-file symlink", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-review-dangling-outside-");
    putLesson(root, makeCandidate("review-dangling-symlink"));
    fs.mkdirSync(path.join(root, "reviews"));
    const outsideFile = path.join(outside, "created-by-review.yaml");
    fs.symlinkSync(
      outsideFile,
      path.join(root, "reviews", "review-dangling-symlink.yaml"),
    );

    expect(() => record(root, "review-dangling-symlink")).toThrow(
      "Review target must not be a symlink",
    );
    expect(fs.existsSync(outsideFile)).toBe(false);
  });

  it("pins the reviews directory across an atomic sidecar write", () => {
    const root = makeLoreRoot();
    const outside = makeTempRoot("pitlore-review-swap-outside-");
    const id = "review-directory-swap";
    putLesson(root, makeCandidate(id));
    const packet = buildReviewPacket(root, id);
    const reviews = path.join(root, "reviews");
    const movedReviews = path.join(root, "reviews-before-swap");
    const target = path.join(reviews, `${id}.yaml`);
    const originalStat = fs.statSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "statSync").mockImplementation(((filePath, options) => {
      if (!swapped && path.resolve(String(filePath)) === path.resolve(target)) {
        swapped = true;
        fs.renameSync(reviews, movedReviews);
        fs.symlinkSync(outside, reviews, "dir");
      }
      return originalStat(filePath, options as never);
    }) as typeof fs.statSync);

    expect(() =>
      recordCandidateReview(
        root,
        id,
        submission(),
        packet.review_context_hash,
      ),
    ).toThrow("Reviews directory changed during filesystem operation");
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.unlinkSync(reviews);
    fs.renameSync(movedReviews, reviews);
  });

  it("creates private review sidecars with owner-only permissions", () => {
    if (process.platform === "win32") return;
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("private-review-mode"));
    const previousUmask = process.umask(0o022);
    let file: string;
    try {
      ({ file } = record(root, "private-review-mode"));
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.statSync(path.join(root, "reviews")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });

  it("does not review a rejected tombstone", () => {
    const root = makeLoreRoot();
    const rejected = validateLesson({
      ...makeCandidate("rejected-review-target"),
      status: "rejected",
    });
    fs.writeFileSync(
      path.join(root, "lessons", `${rejected.id}.yaml`),
      JSON.stringify(rejected),
      "utf8",
    );

    expect(() => buildReviewPacket(root, rejected.id)).toThrow(
      `Only candidate lessons can be reviewed: ${rejected.id}`,
    );
  });

  it("reports invalid sidecars without changing candidate enforcement", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("invalid-review-sidecar"));
    fs.mkdirSync(path.join(root, "reviews"));
    fs.writeFileSync(
      path.join(root, "reviews", "invalid-review-sidecar.yaml"),
      "lesson_id: invalid-review-sidecar\nrecommendation: accept\n",
    );

    const queue = buildReviewQueue(root);
    expect(queue.items[0]?.state).toBe("unreviewed");
    expect(queue.load_errors).toHaveLength(1);
    expect(getLesson(loadStore(root), "invalid-review-sidecar")?.status).toBe(
      "candidate",
    );
  });

  it("fails closed when duplicate sidecars claim the same candidate", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("duplicate-review-sidecars"));
    const { file } = record(root, "duplicate-review-sidecars");
    fs.copyFileSync(
      file,
      path.join(root, "reviews", "duplicate-review-sidecars.yml"),
    );

    const queue = buildReviewQueue(root);
    expect(queue.items[0]?.state).toBe("unreviewed");
    expect(queue.items[0]?.recommendation).toBeUndefined();
    expect(queue.load_errors.some((error) =>
      error.message.includes("duplicate review"),
    )).toBe(true);
  });

  it("strips terminal control characters from the human queue", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("terminal-safe-review"));
    record(root, "terminal-safe-review", {
      ...submission(),
      summary: "Looks fine \u001b[31m\nforged-row \u202ereversed but inspect the scope",
    });

    const output = formatReviewQueue(buildReviewQueue(root));
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
    expect(output).not.toContain("\nforged-row");
    expect(output).toContain("forged-row");
    expect(output).toContain("inspect the scope");
    expect(output).toContain("Reviewer: openai/gpt-5-reviewer (self-reported)");
    expect(output).toContain("Risks:");
  });

  it("exposes the review packet and recording through the CLI", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("cli-review-round-trip"));
    const input = path.join(root, "submission.json");
    fs.writeFileSync(
      input,
      JSON.stringify({
        review_context_hash: buildReviewPacket(root, "cli-review-round-trip")
          .review_context_hash,
        submission: submission(),
      }),
    );
    const env = { ...process.env, PITLORE_LORE: root };

    const packet = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("review", "cli-review-round-trip"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    const recorded = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("review", "cli-review-round-trip", "--input", input),
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    expect(packet).toContain('"candidate_is_untrusted_data": true');
    expect(recorded).toContain("Candidate remains unapproved");
    expect(getLesson(loadStore(root), "cli-review-round-trip")?.status).toBe(
      "candidate",
    );
  });

  it("exposes the advisory review queue through the CLI", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("cli-review-queue"));
    record(root, "cli-review-queue");
    const env = { ...process.env, PITLORE_LORE: root };

    const queue = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs("review-queue"),
      { cwd: repoRoot, env, encoding: "utf8" },
    );

    expect(queue).toContain("current");
    expect(queue).toContain("cli-review-queue");
  });

  it("rejects an LLM submission when context changed after packet creation", () => {
    const root = makeLoreRoot();
    putLesson(root, makeCandidate("context-changed-before-submit"));
    const packet = buildReviewPacket(root, "context-changed-before-submit");
    const stored = getLesson(loadStore(root), "context-changed-before-submit")!;
    putLesson(
      root,
      validateLesson({ ...stored, scope: { paths: ["src/**"] } }),
      { overwrite: true },
    );

    expect(() =>
      recordCandidateReview(
        root,
        "context-changed-before-submit",
        submission(),
        packet.review_context_hash,
      ),
    ).toThrow("review context is stale");
    expect(loadReviewStore(root).reviews).toEqual([]);
  });
});

function makeLoreRoot(): string {
  const root = makeTempRoot("pitlore-review-");
  initLore(root);
  return root;
}

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function makeCandidate(
  id: string,
  overrides: Partial<Lesson> = {},
): Lesson {
  return validateLesson({
    id,
    title: "Review candidate lessons safely",
    languages: ["typescript"],
    ecosystems: ["node"],
    category: "governance",
    symptom: "An unreviewed lesson could enter durable agent memory",
    root_cause: "The review recommendation was confused with authorization",
    forbid_pattern_abstract: "Letting the same model approve durable memory",
    safe_pattern_abstract:
      "Store an advisory review and require a separate human approval action",
    status: "candidate",
    visibility: "private",
    ...overrides,
  });
}

function submission() {
  return {
    recommendation: "edit" as const,
    confidence: 0.86,
    summary: "The lesson is useful but its scope should be more explicit.",
    strengths: ["The failure and safe pattern are clearly separated."],
    risks: ["The scope may be broader than the available evidence."],
    required_changes: ["Narrow the scope to the observed environment."],
    reviewer: { provider: "openai", model: "gpt-5-reviewer" },
  };
}

function record(
  root: string,
  id: string,
  input: unknown = submission(),
) {
  return recordCandidateReview(
    root,
    id,
    input,
    buildReviewPacket(root, id).review_context_hash,
  );
}
