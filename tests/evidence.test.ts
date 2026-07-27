import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatEvidenceSummary,
  loadEvidence,
  recordEvidence as recordEvidenceRaw,
  summarizeEvidence,
} from "../src/evidence.js";
import { validateLesson } from "../src/schema.js";
import {
  approvedCatalogHash,
  approveLesson,
  initLore,
  loadStore,
  putLesson,
} from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeLore(): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-evidence-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, ".pitlore");
  initLore(root);
  return { parent, root };
}

function addCandidate(
  root: string,
  id: string,
  patterns: string[] = [],
): void {
  const lesson = validateLesson({
    id,
    title: `Evidence fixture ${id}`,
    languages: ["typescript"],
    category: "quality",
    symptom: "A known failure mode occurred",
    root_cause: "The required safety invariant was not enforced",
    forbid_pattern_abstract: "Do not repeat the unsafe implementation",
    safe_pattern_abstract: "Apply the reviewed safe implementation",
    severity: "warn",
    status: "candidate",
    visibility: "private",
    enforcement: { patterns },
  });
  putLesson(root, lesson);
}

function addApproved(
  root: string,
  id: string,
  patterns: string[] = [],
): void {
  addCandidate(root, id, patterns);
  approveLesson(root, id);
}

function recordEvidence(root: string, rawInput: unknown) {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return recordEvidenceRaw(root, rawInput);
  }
  return recordEvidenceRaw(root, {
    observed_catalog_hash: approvedCatalogHash(loadStore(root)),
    ...rawInput,
  });
}

function retrieveObservation(options: {
  observationId?: string;
  taskId?: string;
  sampleKind?: "real" | "smoke" | "fixture";
  returned?: string[];
  used?: string[];
  irrelevant?: string[];
  missed?: string[];
  coverageGap?: boolean;
}) {
  const taskId = options.taskId ?? "task-retrieve";
  const signature = [
    ...(options.returned ?? []),
    ...(options.used ?? []),
    ...(options.irrelevant ?? []),
    ...(options.missed ?? []),
    options.coverageGap ? "gap" : "covered",
  ].join(".");
  return {
    type: "retrieve_observation" as const,
    observation_id: options.observationId ?? `${taskId}-${signature}`,
    task_id: taskId,
    client: "codex",
    sample_kind: options.sampleKind ?? ("real" as const),
    returned_lesson_ids: options.returned ?? [],
    used_lesson_ids: options.used ?? [],
    irrelevant_lesson_ids: options.irrelevant ?? [],
    missed_existing_lesson_ids: options.missed ?? [],
    coverage_gap: options.coverageGap ?? false,
    reason: "Human evaluation after completing the coding task",
  };
}

function detectorObservation(options: {
  lessonId: string;
  observationId?: string;
  taskId?: string;
  sampleKind?: "real" | "smoke" | "fixture";
  classification?: "tp" | "fp" | "fn";
  gatePressure?: boolean;
}) {
  const taskId = options.taskId ?? "task-detector";
  const classification = options.classification ?? ("tp" as const);
  return {
    type: "detector_observation" as const,
    observation_id:
      options.observationId ?? `${taskId}-${options.lessonId}-${classification}`,
    task_id: taskId,
    client: "codex",
    sample_kind: options.sampleKind ?? ("real" as const),
    lesson_id: options.lessonId,
    target: "src/service.ts:12",
    classification,
    gate_pressure: options.gatePressure ?? false,
    reason: "Human classification against the intended detector behavior",
  };
}

describe("local evidence ledger", () => {
  it("appends strict events and generates trustworthy local metadata", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");

    const firstInput = retrieveObservation({
      taskId: "task-alpha",
      returned: ["retrieval-alpha"],
      used: ["retrieval-alpha"],
    });
    const first = recordEvidence(
      root,
      firstInput,
    );
    const retry = recordEvidence(root, firstInput);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.event.event_id).toBe(first.event.event_id);

    addApproved(root, "retrieval-beta");
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "task-beta",
        returned: ["retrieval-alpha", "retrieval-beta"],
        used: ["retrieval-beta"],
        irrelevant: ["retrieval-alpha"],
      }),
    );

    const events = loadEvidence(root).events;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.version)).toEqual(["0.1.0", "0.1.0"]);
    expect(new Set(events.map((event) => event.event_id)).size).toBe(2);
    expect(events.every((event) => event.event_id.length > 0)).toBe(true);
    expect(
      events.every((event) => !Number.isNaN(Date.parse(event.recorded_at))),
    ).toBe(true);
    expect(
      events.every((event) => /^[a-f0-9]{64}$/.test(event.observed_catalog_hash)),
    ).toBe(true);
    expect(events[0]?.observed_catalog_hash).not.toBe(
      events[1]?.observed_catalog_hash,
    );

    const ledger = path.join(root, "evidence", "events.jsonl");
    expect(fs.readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rejects an observation when the approved catalog changed after retrieval", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addCandidate(root, "retrieval-later-approved");
    const observation = {
      ...retrieveObservation({
        missed: ["retrieval-later-approved"],
      }),
      observed_catalog_hash: approvedCatalogHash(loadStore(root)),
    };

    approveLesson(root, "retrieval-later-approved");

    expect(() => recordEvidence(root, observation)).toThrow(
      /catalog changed|different catalog|observation/i,
    );
    expect(fs.existsSync(path.join(root, "evidence"))).toBe(false);
  });

  it("coalesces identical concurrent observations and rejects conflicts", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    const first = recordEvidence(
      root,
      retrieveObservation({
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    ).event;
    const ledger = path.join(root, "evidence", "events.jsonl");
    const concurrentDuplicate = {
      ...first,
      event_id: randomUUID(),
      recorded_at: new Date(Date.parse(first.recorded_at) + 1).toISOString(),
    };
    expect(
      summarizeEvidence([first, concurrentDuplicate], {
        mode: "hash",
        catalog_hash: first.observed_catalog_hash,
      }).catalog_scope,
    ).toEqual({
      mode: "hash",
      catalog_hash: first.observed_catalog_hash,
      selected_events: 1,
      available_events: 1,
      distinct_catalog_hashes: 1,
    });
    fs.appendFileSync(ledger, `${JSON.stringify(concurrentDuplicate)}\n`, "utf8");

    const loaded = loadEvidence(root);
    expect(loaded.events).toHaveLength(1);
    expect(summarizeEvidence(loaded).total_events).toBe(1);

    fs.appendFileSync(
      ledger,
      `${JSON.stringify({
        ...concurrentDuplicate,
        event_id: randomUUID(),
        reason: "A conflicting human judgment for the same observation",
      })}\n`,
      "utf8",
    );
    expect(() => loadEvidence(root)).toThrow(/observation_id|conflicting evidence/i);
  });

  it("still detects a reused event id after coalescing an observation", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    const first = recordEvidence(
      root,
      retrieveObservation({
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    ).event;
    const ledger = path.join(root, "evidence", "events.jsonl");
    const concurrentDuplicate = {
      ...first,
      event_id: randomUUID(),
      recorded_at: new Date(Date.parse(first.recorded_at) + 1).toISOString(),
    };
    fs.appendFileSync(ledger, `${JSON.stringify(concurrentDuplicate)}\n`, "utf8");
    fs.appendFileSync(
      ledger,
      `${JSON.stringify({
        ...concurrentDuplicate,
        observation_id: "task-retrieve-second-observation",
        task_id: "task-retrieve-second-observation",
      })}\n`,
      "utf8",
    );

    expect(() => loadEvidence(root)).toThrow(/duplicate event_id/i);
  });

  it.each([
    {
      name: "duplicates a used id",
      returned: ["retrieval-alpha"],
      used: ["retrieval-alpha", "retrieval-alpha"],
      irrelevant: [],
    },
    {
      name: "overlaps used and irrelevant ids",
      returned: ["retrieval-alpha"],
      used: ["retrieval-alpha"],
      irrelevant: ["retrieval-alpha"],
    },
    {
      name: "leaves a returned id unclassified",
      returned: ["retrieval-alpha", "retrieval-beta"],
      used: ["retrieval-alpha"],
      irrelevant: [],
    },
    {
      name: "classifies an id that was not returned",
      returned: ["retrieval-alpha"],
      used: ["retrieval-alpha"],
      irrelevant: ["retrieval-beta"],
    },
  ])("rejects a retrieve partition that $name", ({ returned, used, irrelevant }) => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addApproved(root, "retrieval-beta");

    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({ returned, used, irrelevant }),
      ),
    ).toThrow();
  });

  it("distinguishes missed approved lessons from returned, unknown, and candidate ids", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addApproved(root, "retrieval-beta");
    addCandidate(root, "retrieval-pending");

    recordEvidence(
      root,
      retrieveObservation({
        returned: ["retrieval-alpha"],
        irrelevant: ["retrieval-alpha"],
        missed: ["retrieval-beta"],
      }),
    );
    expect(loadEvidence(root).events[0]).toMatchObject({
      missed_existing_lesson_ids: ["retrieval-beta"],
      coverage_gap: false,
    });

    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
          missed: ["retrieval-alpha"],
        }),
      ),
    ).toThrow();
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({ missed: ["retrieval-pending"] }),
      ),
    ).toThrow(/approved|candidate/i);
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
          coverageGap: true,
        }),
      ),
    ).toThrow(/coverage.gap|used|missed/i);
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          missed: ["retrieval-beta"],
          coverageGap: true,
        }),
      ),
    ).toThrow(/coverage.gap|used|missed/i);
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({ missed: ["retrieval-unknown"] }),
      ),
    ).toThrow(/approved|unknown|not found/i);
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          returned: ["retrieval-pending"],
          used: ["retrieval-pending"],
        }),
      ),
    ).toThrow(/approved|candidate/i);
  });

  it("accepts detector truth labels only for approved lessons with patterns", () => {
    const { root } = makeLore();
    addApproved(root, "detector-active", ["unsafeCall\\s*\\("]);
    addApproved(root, "detector-without-pattern");
    addCandidate(root, "detector-pending", ["pendingCall\\s*\\("]);

    recordEvidence(
      root,
      detectorObservation({ lessonId: "detector-active", classification: "tp" }),
    );
    expect(loadEvidence(root).events[0]).toMatchObject({
      lesson_id: "detector-active",
      classification: "tp",
    });

    expect(() =>
      recordEvidence(
        root,
        detectorObservation({ lessonId: "detector-without-pattern" }),
      ),
    ).toThrow(/pattern|detector/i);
    expect(() =>
      recordEvidence(
        root,
        detectorObservation({ lessonId: "detector-pending" }),
      ),
    ).toThrow(/approved|candidate/i);
    expect(() =>
      recordEvidence(
        root,
        detectorObservation({ lessonId: "detector-unknown" }),
      ),
    ).toThrow(/approved|unknown|not found/i);
  });

  it("rejects raw prompt fields, sensitive reasons, and unsafe detector targets", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addApproved(root, "detector-active", ["unsafeCall\\s*\\("]);

    expect(() =>
      recordEvidence(root, {
        ...retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
        }),
        prompt: "raw task prompt must not enter evidence",
      }),
    ).toThrow(/unrecognized|unknown|strict/i);
    expect(() =>
      recordEvidence(root, {
        ...retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
        }),
        reason: "Contact reviewer@example.com with the result",
      }),
    ).toThrow(/credential|abstract|evidence/i);
    expect(() =>
      recordEvidence(root, {
        ...detectorObservation({ lessonId: "detector-active" }),
        target: "/private/project/src/service.ts",
      }),
    ).toThrow(/relative|target|path/i);
    expect(() =>
      recordEvidence(root, {
        ...detectorObservation({ lessonId: "detector-active" }),
        target: "\\\\server\\share\\service.ts",
      }),
    ).toThrow(/relative|target|path/i);
    expect(() =>
      recordEvidence(root, {
        ...detectorObservation({ lessonId: "detector-active" }),
        target: "file:///private/project/src/service.ts",
      }),
    ).toThrow(/relative|target|path/i);
    expect(() =>
      recordEvidence(root, {
        ...detectorObservation({ lessonId: "detector-active" }),
        target: "~/private/project/src/service.ts",
      }),
    ).toThrow(/relative|target|path/i);
  });

  it("rejects sensitive text injected into an otherwise valid ledger event", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    const event = recordEvidence(
      root,
      retrieveObservation({
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    ).event;
    const ledger = path.join(root, "evidence", "events.jsonl");
    fs.writeFileSync(
      ledger,
      `${JSON.stringify({
        ...event,
        reason: "Contact private-reviewer@example.com for details",
      })}\n`,
      "utf8",
    );

    expect(() => loadEvidence(root)).toThrow(/credential|abstract|evidence/i);
  });

  it("summarizes only real observations and keeps misses separate from coverage gaps", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addApproved(root, "retrieval-beta");
    addApproved(root, "detector-active", ["unsafeCall\\s*\\("]);

    recordEvidence(
      root,
      retrieveObservation({
        taskId: "real-useful",
        returned: ["retrieval-alpha", "retrieval-beta"],
        used: ["retrieval-alpha"],
        irrelevant: ["retrieval-beta"],
      }),
    );
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "real-miss",
        missed: ["retrieval-alpha"],
      }),
    );
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "real-coverage-gap",
        coverageGap: true,
      }),
    );
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "smoke-useful",
        sampleKind: "smoke",
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    );

    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "real-tp",
        classification: "tp",
      }),
    );
    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "real-fp",
        classification: "fp",
        gatePressure: true,
      }),
    );
    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "real-fn",
        classification: "fn",
      }),
    );
    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "fixture-tp",
        sampleKind: "fixture",
        classification: "tp",
      }),
    );

    const summary = summarizeEvidence(loadEvidence(root).events);
    expect(summary.retrieve).toEqual({
      real_observations: 3,
      useful_observations: 1,
      usefulness_rate: 1 / 3,
      returned_lessons: 2,
      used_lessons: 1,
      irrelevant_lessons: 1,
      missed_existing_lessons: 1,
      coverage_gap_observations: 1,
      precision: 0.5,
      recall: 0.5,
    });
    expect(summary.detector).toEqual({
      real_observations: 3,
      true_positives: 1,
      false_positives: 1,
      false_negatives: 1,
      precision: 0.5,
      recall: 0.5,
      gate_pressure_observations: 1,
    });
  });

  it("isolates metrics by catalog hash and discloses cross-catalog aggregates", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    addApproved(root, "detector-active", ["unsafeCall\\s*\\("]);

    recordEvidence(
      root,
      retrieveObservation({
        taskId: "catalog-a-retrieve",
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    );
    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "catalog-a-detector",
        classification: "fp",
      }),
    );
    const catalogA = loadEvidence(root).events[0].observed_catalog_hash;

    addApproved(root, "catalog-shift");
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "catalog-b-retrieve",
        returned: ["retrieval-alpha"],
        irrelevant: ["retrieval-alpha"],
      }),
    );
    recordEvidence(
      root,
      detectorObservation({
        lessonId: "detector-active",
        taskId: "catalog-b-detector",
        classification: "tp",
      }),
    );
    const events = loadEvidence(root).events;
    const catalogB = events.at(-1)?.observed_catalog_hash;
    expect(catalogB).toBeDefined();
    expect(catalogB).not.toBe(catalogA);

    const aggregate = summarizeEvidence(events);
    const first = summarizeEvidence(events, {
      mode: "hash",
      catalog_hash: catalogA,
    });
    const current = summarizeEvidence(events, {
      mode: "current",
      catalog_hash: catalogB!,
    });

    expect(aggregate.total_events).toBe(4);
    expect(aggregate.catalog_scope).toEqual({
      mode: "all",
      catalog_hash: null,
      selected_events: 4,
      available_events: 4,
      distinct_catalog_hashes: 2,
    });
    expect(formatEvidenceSummary(aggregate)).toContain(
      "cross-catalog aggregate",
    );
    expect(first.retrieve.usefulness_rate).toBe(1);
    expect(first.detector).toMatchObject({
      true_positives: 0,
      false_positives: 1,
      precision: 0,
    });
    expect(current.catalog_scope?.catalog_hash).toBe(catalogB);
    expect(current.retrieve.usefulness_rate).toBe(0);
    expect(current.detector).toMatchObject({
      true_positives: 1,
      false_positives: 0,
      precision: 1,
    });
    expect(formatEvidenceSummary(current)).toContain(catalogB!);

    expect(() =>
      summarizeEvidence(events, {
        mode: "hash",
        catalog_hash: "A".repeat(64),
      }),
    ).toThrow(/lowercase SHA-256/i);
    const unknownHash = ["0".repeat(64), "f".repeat(64)].find(
      (hash) => hash !== catalogA && hash !== catalogB,
    )!;
    expect(() =>
      summarizeEvidence(events, {
        mode: "hash",
        catalog_hash: unknownHash,
      }),
    ).toThrow(/No evidence found/i);

    addApproved(root, "catalog-without-events");
    const emptyCurrent = summarizeEvidence(events, {
      mode: "current",
      catalog_hash: approvedCatalogHash(loadStore(root)),
    });
    expect(emptyCurrent.catalog_scope).toMatchObject({
      mode: "current",
      selected_events: 0,
      available_events: 4,
      distinct_catalog_hashes: 2,
    });
    expect(emptyCurrent.retrieve.usefulness_rate).toBeNull();
    expect(emptyCurrent.detector.precision).toBeNull();
  });

  it("supports all, current, and historical catalog scopes through the CLI", () => {
    const { parent, root } = makeLore();
    addApproved(root, "retrieval-alpha");
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "cli-catalog-a",
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    );
    const catalogA = loadEvidence(root).events[0].observed_catalog_hash;
    addApproved(root, "retrieval-beta");
    recordEvidence(
      root,
      retrieveObservation({
        taskId: "cli-catalog-b",
        returned: ["retrieval-beta"],
        irrelevant: ["retrieval-beta"],
      }),
    );
    const catalogB = loadEvidence(root).events[1].observed_catalog_hash;
    const env = { ...process.env, PITLORE_LORE: root };
    const summary = (...args: string[]) =>
      execFileSync(
        pitloreCliCommand,
        pitloreCliArgs("evidence", "summary", "--json", ...args),
        { cwd: parent, env, encoding: "utf8" },
      );

    expect(JSON.parse(summary()).catalog_scope).toMatchObject({
      mode: "all",
      selected_events: 2,
      distinct_catalog_hashes: 2,
    });
    expect(JSON.parse(summary("--catalog", "current")).catalog_scope).toEqual({
      mode: "current",
      catalog_hash: catalogB,
      selected_events: 1,
      available_events: 2,
      distinct_catalog_hashes: 2,
    });
    expect(JSON.parse(summary("--catalog", catalogA)).catalog_scope).toMatchObject({
      mode: "hash",
      catalog_hash: catalogA,
      selected_events: 1,
    });
    expect(
      execFileSync(
        pitloreCliCommand,
        pitloreCliArgs("evidence", "summary", "--catalog", "current"),
        { cwd: parent, env, encoding: "utf8" },
      ),
    ).toContain(catalogB);

    const invalid = spawnSync(
      pitloreCliCommand,
      pitloreCliArgs(
        "evidence",
        "summary",
        "--catalog",
        "A".repeat(64),
      ),
      {
        cwd: parent,
        env: {
          ...process.env,
          PITLORE_LORE: path.join(parent, "missing-lore"),
        },
        encoding: "utf8",
      },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toMatch(/catalog|lowercase SHA-256/i);

    const unknownHash = ["0".repeat(64), "f".repeat(64)].find(
      (hash) => hash !== catalogA && hash !== catalogB,
    )!;
    const unknown = spawnSync(
      pitloreCliCommand,
      pitloreCliArgs(
        "evidence",
        "summary",
        "--catalog",
        unknownHash,
      ),
      { cwd: parent, env, encoding: "utf8" },
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toMatch(/No evidence found/i);
  }, 20_000);

  it("uses null for empty denominators and never formats missing data as 100%", () => {
    const summary = summarizeEvidence([]);

    expect(summary.retrieve.usefulness_rate).toBeNull();
    expect(summary.detector.precision).toBeNull();
    expect(summary.detector.recall).toBeNull();
    const formatted = formatEvidenceSummary(summary);
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).not.toMatch(/100(?:\.0+)?%/);
  });

  it("fails closed instead of partially loading corrupted JSONL", () => {
    const { root } = makeLore();
    addApproved(root, "retrieval-alpha");
    recordEvidence(
      root,
      retrieveObservation({
        returned: ["retrieval-alpha"],
        used: ["retrieval-alpha"],
      }),
    );
    fs.appendFileSync(
      path.join(root, "evidence", "events.jsonl"),
      "{not-valid-json}\n",
      "utf8",
    );
    const before = fs.readFileSync(
      path.join(root, "evidence", "events.jsonl"),
      "utf8",
    );

    expect(() => loadEvidence(root)).toThrow(/evidence|json|invalid|corrupt/i);
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          taskId: "after-corruption",
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
        }),
      ),
    ).toThrow(/evidence|json|invalid|corrupt/i);
    expect(
      fs.readFileSync(path.join(root, "evidence", "events.jsonl"), "utf8"),
    ).toBe(before);
  });

  it("refuses an evidence directory symlink that escapes the lore root", () => {
    const { parent, root } = makeLore();
    addApproved(root, "retrieval-alpha");
    const outside = path.join(parent, "outside-evidence");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "evidence"), "dir");

    expect(() => loadEvidence(root)).toThrow(
      /evidence directory|real directory|symlink|symbolic|outside|escape/i,
    );
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
        }),
      ),
    ).toThrow(
      /evidence directory|real directory|symlink|symbolic|outside|escape/i,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses an events file symlink instead of reading or appending outside lore", () => {
    const { parent, root } = makeLore();
    addApproved(root, "retrieval-alpha");
    const evidenceDir = path.join(root, "evidence");
    fs.mkdirSync(evidenceDir);
    const outside = path.join(parent, "outside-events.jsonl");
    fs.writeFileSync(outside, "", "utf8");
    fs.symlinkSync(outside, path.join(evidenceDir, "events.jsonl"));

    expect(() => loadEvidence(root)).toThrow(
      /evidence file|regular file|symlink|symbolic|outside|escape/i,
    );
    expect(() =>
      recordEvidence(
        root,
        retrieveObservation({
          returned: ["retrieval-alpha"],
          used: ["retrieval-alpha"],
        }),
      ),
    ).toThrow(
      /evidence file|regular file|symlink|symbolic|outside|escape/i,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("");
  });
});
