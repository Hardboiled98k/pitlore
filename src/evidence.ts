import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEffectiveStore } from "./pack.js";
import { resolveLoreRoot } from "./paths.js";
import {
  validateEvidenceEvent,
  validateEvidenceInput,
  type DetectorObservation,
  type EvidenceEvent,
  type EvidenceInput,
  type RetrieveObservation,
} from "./schema.js";
import {
  approvedCatalogHash,
  ensureWritableLoreRoot,
  getLesson,
  loadStore,
  type LoreStore,
  type WritableLoreRootOptions,
} from "./store.js";

export interface EvidenceStore {
  root: string;
  events: EvidenceEvent[];
}

export type EvidenceCatalogFilter =
  | { mode: "all" }
  | { mode: "current"; catalog_hash: string }
  | { mode: "hash"; catalog_hash: string };

export interface EvidenceCatalogScope {
  mode: EvidenceCatalogFilter["mode"];
  catalog_hash: string | null;
  selected_events: number;
  available_events: number;
  distinct_catalog_hashes: number;
}

export interface EvidenceSummary {
  catalog_scope?: EvidenceCatalogScope;
  total_events: number;
  sample_counts: {
    real: number;
    smoke: number;
    fixture: number;
  };
  retrieve: {
    real_observations: number;
    useful_observations: number;
    usefulness_rate: number | null;
    returned_lessons: number;
    used_lessons: number;
    irrelevant_lessons: number;
    missed_existing_lessons: number;
    coverage_gap_observations: number;
    precision: number | null;
    recall: number | null;
  };
  detector: {
    real_observations: number;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    precision: number | null;
    recall: number | null;
    gate_pressure_observations: number;
  };
}

const SENSITIVE_EVIDENCE_HINT =
  /(?:\bsk-[a-z0-9_-]{10,}\b|\bgh[pousr]_[a-z0-9]{20,}\b|\bgithub_pat_[a-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bapi[_-]?key["']?\s*[:=]|\bpassword["']?\s*[:=]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

export function recordEvidence(
  root: string,
  rawInput: unknown,
  options: WritableLoreRootOptions = {},
): { event: EvidenceEvent; file: string; created: boolean } {
  const input = validateEvidenceInput(rawInput);
  assertEvidenceTextSafe(input);

  const writableRoot = ensureWritableLoreRoot(root, options);
  const existingEvidence = loadEvidence(writableRoot);
  const existing = existingEvidence.events.find(
    (event) => event.observation_id === input.observation_id,
  );
  if (existing) {
    if (JSON.stringify(evidenceInputFromEvent(existing)) !== JSON.stringify(input)) {
      throw new Error(
        `observation_id already exists with different evidence: ${input.observation_id}`,
      );
    }
    const existingFile = resolveEvidenceFile(writableRoot, false);
    if (!existingFile) {
      throw new Error(`Evidence ledger missing for ${input.observation_id}`);
    }
    return { event: existing, file: existingFile, created: false };
  }

  const store = loadEffectiveStore(writableRoot);
  assertEvidenceInput(input, store);
  const catalogHash = approvedCatalogHash(store);
  if (input.observed_catalog_hash !== catalogHash) {
    throw new Error(
      "Approved catalog changed since the observation; do not record it against a different catalog",
    );
  }

  const event = validateEvidenceEvent({
    ...input,
    version: "0.1.0",
    event_id: randomUUID(),
    recorded_at: new Date().toISOString(),
  });
  assertEvidenceStructure(event);

  const currentStore = loadEffectiveStore(writableRoot);
  assertEvidenceInput(input, currentStore);
  if (approvedCatalogHash(currentStore) !== input.observed_catalog_hash) {
    throw new Error("Approved catalog changed during evidence recording; retry");
  }

  const file = resolveEvidenceFile(writableRoot, true);
  appendJsonLine(file, event);
  return { event, file, created: true };
}

export function loadEvidence(root = resolveLoreRoot()): EvidenceStore {
  const store = loadStore(root);
  const file = resolveEvidenceFile(store.root, false);
  if (!file || !fs.existsSync(file)) {
    return { root: store.root, events: [] };
  }

  const raw = readEvidenceFile(file);
  const events: EvidenceEvent[] = [];
  const seenIds = new Set<string>();
  const seenObservations = new Map<string, EvidenceEvent>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      const event = validateEvidenceEvent(JSON.parse(line));
      assertEvidenceStructure(event);
      assertEvidenceTextSafe(evidenceInputFromEvent(event));
      if (seenIds.has(event.event_id)) {
        throw new Error(`duplicate event_id ${event.event_id}`);
      }
      const previous = seenObservations.get(event.observation_id);
      if (previous) {
        if (!sameObservation(previous, event)) {
          throw new Error(
            `observation_id ${event.observation_id} has conflicting evidence`,
          );
        }
        seenIds.add(event.event_id);
        continue;
      }
      seenIds.add(event.event_id);
      seenObservations.set(event.observation_id, event);
      events.push(event);
    } catch (error) {
      throw new Error(
        `Invalid evidence event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { root: store.root, events };
}

export function summarizeEvidence(
  evidence: EvidenceStore | EvidenceEvent[],
  filter: EvidenceCatalogFilter = { mode: "all" },
): EvidenceSummary {
  const availableEvents = coalesceEvidenceEvents(
    Array.isArray(evidence) ? evidence : evidence.events,
  );
  const distinctCatalogHashes = new Set(
    availableEvents.map((event) => event.observed_catalog_hash),
  );
  const catalogHash = catalogHashForFilter(filter);
  if (
    filter.mode === "hash" &&
    !distinctCatalogHashes.has(filter.catalog_hash)
  ) {
    throw new Error(
      `No evidence found for catalog hash: ${filter.catalog_hash}`,
    );
  }
  const events = catalogHash
    ? availableEvents.filter(
        (event) => event.observed_catalog_hash === catalogHash,
      )
    : availableEvents;
  const sampleCounts = { real: 0, smoke: 0, fixture: 0 };
  for (const event of events) sampleCounts[event.sample_kind] += 1;

  const realRetrieve = events.filter(
    (event): event is RetrieveObservation =>
      event.type === "retrieve_observation" && event.sample_kind === "real",
  );
  const realDetector = events.filter(
    (event): event is DetectorObservation =>
      event.type === "detector_observation" && event.sample_kind === "real",
  );

  const used = sum(realRetrieve.map((event) => event.used_lesson_ids.length));
  const irrelevant = sum(
    realRetrieve.map((event) => event.irrelevant_lesson_ids.length),
  );
  const missedExisting = sum(
    realRetrieve.map((event) => event.missed_existing_lesson_ids.length),
  );
  const truePositives = realDetector.filter(
    (event) => event.classification === "tp",
  ).length;
  const falsePositives = realDetector.filter(
    (event) => event.classification === "fp",
  ).length;
  const falseNegatives = realDetector.filter(
    (event) => event.classification === "fn",
  ).length;

  return {
    catalog_scope: {
      mode: filter.mode,
      catalog_hash: catalogHash,
      selected_events: events.length,
      available_events: availableEvents.length,
      distinct_catalog_hashes: distinctCatalogHashes.size,
    },
    total_events: events.length,
    sample_counts: sampleCounts,
    retrieve: {
      real_observations: realRetrieve.length,
      useful_observations: realRetrieve.filter(
        (event) => event.used_lesson_ids.length > 0,
      ).length,
      usefulness_rate: ratio(
        realRetrieve.filter((event) => event.used_lesson_ids.length > 0).length,
        realRetrieve.length,
      ),
      returned_lessons: sum(
        realRetrieve.map((event) => event.returned_lesson_ids.length),
      ),
      used_lessons: used,
      irrelevant_lessons: irrelevant,
      missed_existing_lessons: missedExisting,
      coverage_gap_observations: realRetrieve.filter(
        (event) => event.coverage_gap,
      ).length,
      precision: ratio(used, used + irrelevant),
      recall: ratio(used, used + missedExisting),
    },
    detector: {
      real_observations: realDetector.length,
      true_positives: truePositives,
      false_positives: falsePositives,
      false_negatives: falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(truePositives, truePositives + falseNegatives),
      gate_pressure_observations: realDetector.filter(
        (event) => event.gate_pressure,
      ).length,
    },
  };
}

export function formatEvidenceSummary(summary: EvidenceSummary): string {
  return [
    "PitLore evidence summary",
    ...(summary.catalog_scope ? [formatCatalogScope(summary.catalog_scope)] : []),
    `Total events: ${summary.total_events} (real ${summary.sample_counts.real}, smoke ${summary.sample_counts.smoke}, fixture ${summary.sample_counts.fixture})`,
    `Retrieve: ${summary.retrieve.real_observations} real observation(s), ${summary.retrieve.useful_observations} useful`,
    `  Usefulness: ${formatRatio(summary.retrieve.usefulness_rate)}`,
    `  Precision: ${formatRatio(summary.retrieve.precision)}; recall: ${formatRatio(summary.retrieve.recall)}`,
    `  Missed existing: ${summary.retrieve.missed_existing_lessons}; coverage gaps: ${summary.retrieve.coverage_gap_observations}`,
    `Detector: ${summary.detector.real_observations} real observation(s), TP ${summary.detector.true_positives}, FP ${summary.detector.false_positives}, FN ${summary.detector.false_negatives}`,
    `  Precision: ${formatRatio(summary.detector.precision)}; recall: ${formatRatio(summary.detector.recall)}`,
    `  Gate-pressure observations: ${summary.detector.gate_pressure_observations}`,
  ].join("\n");
}

function catalogHashForFilter(filter: EvidenceCatalogFilter): string | null {
  if (filter.mode === "all") return null;
  if (filter.mode !== "current" && filter.mode !== "hash") {
    const unknownFilter = filter as { mode: unknown };
    throw new Error(
      `Unknown evidence catalog filter: ${String(unknownFilter.mode)}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(filter.catalog_hash)) {
    throw new Error(
      "Evidence catalog hash must be a 64-character lowercase SHA-256",
    );
  }
  return filter.catalog_hash;
}

function formatCatalogScope(scope: EvidenceCatalogScope): string {
  const hash = scope.catalog_hash ? ` ${scope.catalog_hash}` : "";
  const aggregate =
    scope.mode === "all" && scope.distinct_catalog_hashes > 1
      ? "; cross-catalog aggregate"
      : "";
  return `Catalog scope: ${scope.mode}${hash} (${scope.selected_events}/${scope.available_events} logical events; ${scope.distinct_catalog_hashes} catalog hash(es) available${aggregate})`;
}

function assertEvidenceInput(input: EvidenceInput, store: LoreStore): void {
  assertEvidenceStructure(input);
  const approved = new Set(
    store.lessons
      .filter((lesson) => lesson.status === "approved")
      .map((lesson) => lesson.id),
  );

  if (input.type === "retrieve_observation") {
    for (const [field, ids] of [
      ["returned_lesson_ids", input.returned_lesson_ids],
      ["missed_existing_lesson_ids", input.missed_existing_lesson_ids],
    ] as const) {
      for (const id of ids) {
        if (!approved.has(id)) {
          throw new Error(`${field} must reference a currently approved lesson: ${id}`);
        }
      }
    }
    return;
  }

  const lesson = getLesson(store, input.lesson_id);
  if (!lesson || lesson.status !== "approved") {
    throw new Error(
      `detector observation must reference a currently approved lesson: ${input.lesson_id}`,
    );
  }
  if (!lesson.enforcement.patterns.some((pattern) => pattern.trim().length > 0)) {
    throw new Error(
      `detector observation requires a lesson with a declarative pattern: ${input.lesson_id}`,
    );
  }
}

function assertEvidenceStructure(input: EvidenceInput | EvidenceEvent): void {
  if (input.type !== "retrieve_observation") return;

  assertUnique("returned_lesson_ids", input.returned_lesson_ids);
  assertUnique("used_lesson_ids", input.used_lesson_ids);
  assertUnique("irrelevant_lesson_ids", input.irrelevant_lesson_ids);
  assertUnique("missed_existing_lesson_ids", input.missed_existing_lesson_ids);

  const returned = new Set(input.returned_lesson_ids);
  const used = new Set(input.used_lesson_ids);
  const irrelevant = new Set(input.irrelevant_lesson_ids);
  for (const id of used) {
    if (!returned.has(id)) {
      throw new Error(`used_lesson_ids must be a subset of returned_lesson_ids: ${id}`);
    }
    if (irrelevant.has(id)) {
      throw new Error(`a returned lesson cannot be both used and irrelevant: ${id}`);
    }
  }
  for (const id of irrelevant) {
    if (!returned.has(id)) {
      throw new Error(
        `irrelevant_lesson_ids must be a subset of returned_lesson_ids: ${id}`,
      );
    }
  }
  if (used.size + irrelevant.size !== returned.size) {
    throw new Error(
      "used_lesson_ids and irrelevant_lesson_ids must classify every returned lesson",
    );
  }
  for (const id of input.missed_existing_lesson_ids) {
    if (returned.has(id)) {
      throw new Error(
        `missed_existing_lesson_ids must not include a returned lesson: ${id}`,
      );
    }
  }
  if (
    input.coverage_gap &&
    (used.size > 0 || input.missed_existing_lesson_ids.length > 0)
  ) {
    throw new Error(
      "coverage_gap cannot be combined with used or missed-existing lessons",
    );
  }
}

function assertEvidenceTextSafe(input: EvidenceInput): void {
  if (SENSITIVE_EVIDENCE_HINT.test(JSON.stringify(input))) {
    throw new Error(
      "Evidence may contain a credential; record only abstract reasons, lesson ids, and relative targets",
    );
  }
}

function resolveEvidenceFile(root: string, create: true): string;
function resolveEvidenceFile(root: string, create: false): string | undefined;
function resolveEvidenceFile(root: string, create: boolean): string | undefined {
  const resolvedRoot = path.resolve(root);
  const directory = path.join(resolvedRoot, "evidence");
  if (!fs.existsSync(directory)) {
    if (!create) return undefined;
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  }

  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Evidence directory must be a real directory: ${directory}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realDirectory = fs.realpathSync(directory);
  if (!isSameOrWithin(realDirectory, realRoot)) {
    throw new Error(`Evidence directory escapes the lore root: ${directory}`);
  }

  const file = path.join(directory, "events.jsonl");
  if (fs.existsSync(file)) {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Evidence file must be a regular file: ${file}`);
    }
    if (!isSameOrWithin(fs.realpathSync(file), realRoot)) {
      throw new Error(`Evidence file escapes the lore root: ${file}`);
    }
  }
  return file;
}

function appendJsonLine(file: string, event: EvidenceEvent): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`Evidence file must be a regular file: ${file}`);
    }
    const payload = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const written = fs.writeSync(
        descriptor,
        payload,
        offset,
        payload.length - offset,
        null,
      );
      if (written <= 0) throw new Error(`Could not append evidence event: ${file}`);
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readEvidenceFile(file: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`Evidence file must be a regular file: ${file}`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertUnique(field: string, values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
}

function coalesceEvidenceEvents(events: EvidenceEvent[]): EvidenceEvent[] {
  const eventIds = new Set<string>();
  const observations = new Map<string, EvidenceEvent>();
  const unique: EvidenceEvent[] = [];
  for (const event of events) {
    if (eventIds.has(event.event_id)) {
      throw new Error(`duplicate event_id ${event.event_id}`);
    }
    const previous = observations.get(event.observation_id);
    if (previous) {
      if (!sameObservation(previous, event)) {
        throw new Error(
          `observation_id ${event.observation_id} has conflicting evidence`,
        );
      }
      eventIds.add(event.event_id);
      continue;
    }
    eventIds.add(event.event_id);
    observations.set(event.observation_id, event);
    unique.push(event);
  }
  return unique;
}

function evidenceInputFromEvent(event: EvidenceEvent): EvidenceInput {
  const {
    version: _version,
    event_id: _eventId,
    recorded_at: _recordedAt,
    ...input
  } = event;
  return validateEvidenceInput(input);
}

function sameObservation(left: EvidenceEvent, right: EvidenceEvent): boolean {
  return (
    JSON.stringify(evidenceInputFromEvent(left)) ===
    JSON.stringify(evidenceInputFromEvent(right))
  );
}

function isSameOrWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function formatRatio(value: number | null): string {
  return value === null ? "insufficient data" : `${(value * 100).toFixed(1)}%`;
}
