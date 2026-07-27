import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { checkContent } from "./check.js";
import {
  assertPublicSafe,
  LessonIdSchema,
  type CandidateReview,
  type Lesson,
  type Manifest,
  validateCandidateReview,
  validateLesson,
  validateManifest,
} from "./schema.js";
import {
  defaultProjectLore,
  resolveLoreRoot,
  seedDir,
} from "./paths.js";

export interface LoreStore {
  root: string;
  manifest: Manifest;
  lessons: Lesson[];
  loadErrors: LoreLoadError[];
}

export interface LoreLoadError {
  filePath: string;
  message: string;
}

export interface ReviewStore {
  root: string;
  reviews: CandidateReview[];
  loadErrors: ReviewLoadError[];
}

export interface ReviewLoadError {
  filePath: string;
  message: string;
}

export interface ApprovalReadiness {
  ready: boolean;
  issues: string[];
}

export interface ApprovalFixtureSnapshot {
  hashes: Record<string, string>;
}

export interface WritableLoreRootOptions {
  cwd?: string;
  onCreate?: (root: string) => void;
}

export interface PutLessonOptions extends WritableLoreRootOptions {
  overwrite?: boolean;
}

function readTextFileNoFollow(
  filePath: string,
  options: {
    label?: string;
    assertDirectoryCurrent?: () => void;
    expectedFileIdentity?: FileIdentity;
  } = {},
): string {
  const label = options.label ?? "File";
  const assertDirectoryCurrent = options.assertDirectoryCurrent ?? (() => {});
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  let raw: string;
  assertDirectoryCurrent();
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    assertDirectoryCurrent();
    const entry = fs.fstatSync(descriptor);
    if (!entry.isFile()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    if (
      options.expectedFileIdentity &&
      (entry.dev !== options.expectedFileIdentity.dev ||
        entry.ino !== options.expectedFileIdentity.ino)
    ) {
      throw new Error(`${label} changed during read: ${filePath}`);
    }
    raw = fs.readFileSync(descriptor, "utf8");
    assertDirectoryCurrent();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ELOOP", "EMLINK"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw new Error(`${label} must not be a symlink: ${filePath}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  assertDirectoryCurrent();
  return raw;
}

function readYamlFile(
  filePath: string,
  options: {
    label?: string;
    assertDirectoryCurrent?: () => void;
    expectedFileIdentity?: FileIdentity;
  } = {},
): unknown {
  return yaml.load(
    readTextFileNoFollow(filePath, {
      ...options,
      label: options.label ?? "YAML file",
    }),
  );
}

interface AtomicWriteOptions {
  exclusive?: boolean;
  assertDirectoryCurrent?: () => void;
  mode?: number;
}

function writeFileAtomically(
  filePath: string,
  body: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(filePath);
  const assertDirectoryCurrent = options.assertDirectoryCurrent ?? (() => {});
  assertDirectoryCurrent();
  assertNotSymbolicLink(filePath, "File target");
  let mode = options.mode ?? 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  assertDirectoryCurrent();
  const temporary = path.join(directory, `.pitlore-write-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let primaryError: unknown;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    if (process.platform !== "win32") fs.fchmodSync(descriptor, mode);
    temporaryIdentity = fileIdentity(fs.fstatSync(descriptor));
    assertDirectoryCurrent();
    assertSameFile(temporary, temporaryIdentity, "Atomic temporary file");
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertDirectoryCurrent();
    assertSameFile(temporary, temporaryIdentity, "Atomic temporary file");
    if (options.exclusive) {
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, filePath);
    }
    assertDirectoryCurrent();
    syncDirectory(directory);
    assertDirectoryCurrent();
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: string[] = [];
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    assertDirectoryCurrent();
    if (lstatIfExists(temporary)) {
      if (!temporaryIdentity) {
        throw new Error(`Atomic temporary file identity is unknown: ${temporary}`);
      }
      assertSameFile(temporary, temporaryIdentity, "Atomic temporary file");
      fs.unlinkSync(temporary);
    }
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (primaryError !== undefined) {
    throwWithCleanupContext(
      primaryError,
      cleanupErrors,
      "temporary-file cleanup also failed",
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      `Atomic write completed but temporary-file cleanup failed: ${cleanupErrors.join("; ")}`,
    );
  }
}

function writeYamlFileAtomically(
  filePath: string,
  data: unknown,
  options: AtomicWriteOptions = {},
): void {
  const body = yaml.dump(data, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  writeFileAtomically(filePath, body, options);
}

export function loadStore(root = resolveLoreRoot()): LoreStore {
  const rootEntry = lstatIfExists(root);
  if (!rootEntry) {
    throw new Error(
      `No lore found at ${root}. Run: pitlore init  (or set PITLORE_LORE)`,
    );
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`Lore root must be a real directory: ${root}`);
  }
  const rootIdentity = captureDirectoryIdentity(root, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(root, root, rootIdentity, "Lore root");
  const manifestPath = path.join(root, "manifest.yaml");
  assertRootCurrent();
  const manifestEntry = lstatIfExists(manifestPath);
  if (manifestEntry?.isSymbolicLink()) {
    throw new Error(`Lore manifest must not be a symlink: ${manifestPath}`);
  }
  if (!manifestEntry) {
    throw new Error(
      `No lore found at ${root}. Run: pitlore init  (or set PITLORE_LORE)`,
    );
  }
  if (!isSameOrWithin(manifestPath, root)) {
    throw new Error(`Lore manifest escapes the lore root: ${manifestPath}`);
  }
  const manifest = validateManifest(
    readYamlFile(manifestPath, {
      label: "Lore manifest",
      assertDirectoryCurrent: assertRootCurrent,
      expectedFileIdentity: fileIdentity(manifestEntry),
    }),
  );
  const lessonsDir = path.join(root, "lessons");
  const lessons: Lesson[] = [];
  const loadErrors: LoreLoadError[] = [];
  const seenIds = new Map<string, string>();
  const lessonsEntry = lstatIfExists(lessonsDir);
  if (lessonsEntry?.isSymbolicLink()) {
    throw new Error(`Lessons directory must not be a symlink: ${lessonsDir}`);
  }
  if (lessonsEntry) {
    if (!isSameOrWithin(lessonsDir, root)) {
      throw new Error(`Lessons directory escapes the lore root: ${lessonsDir}`);
    }
    const lessonsIdentity = captureDirectoryIdentity(
      lessonsDir,
      "Lessons directory",
    );
    const assertLessonsCurrent = () => {
      assertRootCurrent();
      assertSameDirectory(
        lessonsDir,
        root,
        lessonsIdentity,
        "Lessons directory",
      );
    };
    assertLessonsCurrent();
    for (const name of fs.readdirSync(lessonsDir).sort()) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const file = path.join(lessonsDir, name);
      try {
        assertLessonsCurrent();
        const lessonEntry = fs.lstatSync(file);
        if (lessonEntry.isSymbolicLink()) {
          throw new Error("lesson file must not be a symlink");
        }
        if (!isSameOrWithin(file, root)) {
          throw new Error("lesson file escapes the lore root");
        }
        const lesson = validateLesson(
          readYamlFile(file, {
            label: "Lesson file",
            assertDirectoryCurrent: assertLessonsCurrent,
            expectedFileIdentity: fileIdentity(lessonEntry),
          }),
        );
        if (path.parse(name).name !== lesson.id) {
          throw new Error(
            `lesson id ${lesson.id} does not match filename ${name}`,
          );
        }
        const previous = seenIds.get(lesson.id);
        if (previous) {
          throw new Error(
            `duplicate lesson id ${lesson.id} also declared by ${previous}`,
          );
        }
        const safetyIssues = assertPublicSafe(lesson);
        if (safetyIssues.length > 0) {
          throw new Error(`unsafe public lesson: ${safetyIssues.join("; ")}`);
        }
        seenIds.set(lesson.id, name);
        lessons.push(lesson);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        loadErrors.push({ filePath: file, message: msg });
        console.warn(`Skipping invalid lesson ${name}: ${msg}`);
      }
    }
    assertLessonsCurrent();
  }
  assertRootCurrent();
  return { root, manifest, lessons, loadErrors };
}

export function initLore(
  root: string,
  options: {
    name?: string;
    description?: string;
    visibility?: "private" | "public";
    copySeed?: boolean;
    seedDir?: string;
  } = {},
): LoreStore {
  if (isSameOrWithin(root, seedDir())) {
    throw new Error(`Refusing to initialize lore inside bundled seed: ${root}`);
  }
  const existingRoot = lstatIfExists(root);
  if (existingRoot?.isSymbolicLink()) {
    throw new Error(`Lore root must not be a symlink: ${root}`);
  }
  if (existingRoot && !existingRoot.isDirectory()) {
    throw new Error(`Lore root is not a directory: ${root}`);
  }
  const privateStore = (options.visibility ?? "private") === "private";
  const directoryMode = privateStore ? 0o700 : 0o755;
  const fileMode = privateStore ? 0o600 : 0o644;
  fs.mkdirSync(root, { recursive: true, mode: directoryMode });
  const rootIdentity = captureDirectoryIdentity(root, "Lore root");
  setDirectoryMode(root, rootIdentity, directoryMode, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(root, root, rootIdentity, "Lore root");
  const lessonsDir = path.join(root, "lessons");
  const manifestPath = path.join(root, "manifest.yaml");
  const readme = path.join(root, "README.md");
  assertRootCurrent();
  assertWritableFileTarget(root, manifestPath, "Lore manifest");
  assertWritableFileTarget(root, readme, "Lore README");
  ensureWritableDirectory(
    root,
    lessonsDir,
    "Lessons directory",
    assertRootCurrent,
  );
  const lessonsIdentity = captureDirectoryIdentity(
    lessonsDir,
    "Lessons directory",
  );
  setDirectoryMode(
    lessonsDir,
    lessonsIdentity,
    directoryMode,
    "Lessons directory",
  );
  const assertLessonsCurrent = () => {
    assertRootCurrent();
    assertSameDirectory(
      lessonsDir,
      root,
      lessonsIdentity,
      "Lessons directory",
    );
  };
  const seedCopies: Array<{ source: string; destination: string }> = [];
  if (options.copySeed && options.seedDir && fs.existsSync(options.seedDir)) {
    const seedLessons = path.join(options.seedDir, "lessons");
    if (fs.existsSync(seedLessons)) {
      for (const name of fs.readdirSync(seedLessons)) {
        if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
        assertLessonsCurrent();
        const destination = path.join(lessonsDir, name);
        const entry = lstatIfExists(destination);
        if (entry?.isSymbolicLink()) {
          throw new Error(
            `Seed lesson target must not be a symlink: ${destination}`,
          );
        }
        if (!entry) {
          assertWritableFileTarget(root, destination, "Seed lesson target");
          seedCopies.push({
            source: path.join(seedLessons, name),
            destination,
          });
        }
      }
    }
  }
  const manifest: Manifest = validateManifest({
    name: options.name ?? path.basename(path.dirname(root)) + "/lore",
    description:
      options.description ??
      "Local PitLore — executable lessons from past bugs.",
    visibility: options.visibility ?? "private",
    version: "0.1.0",
    default_status_for_new: "candidate",
  });
  for (const { source, destination } of seedCopies) {
    assertLessonsCurrent();
    writeFileAtomically(destination, fs.readFileSync(source), {
      exclusive: true,
      assertDirectoryCurrent: assertLessonsCurrent,
      mode: fileMode,
    });
  }

  const now = new Date().toISOString();
  assertRootCurrent();
  const readmeEntry = lstatIfExists(readme);
  if (!readmeEntry) {
    writeFileAtomically(
      readme,
      `# ${manifest.name}\n\nPitLore local lore store.\n\nCreated: ${now}\n`,
      {
        exclusive: true,
        assertDirectoryCurrent: assertRootCurrent,
        mode: fileMode,
      },
    );
  }

  // manifest.yaml is the initialization commit marker. If any seed or README
  // write fails, ensureWritableLoreRoot will retry instead of treating a
  // partially initialized directory as complete.
  writeYamlFileAtomically(manifestPath, manifest, {
    assertDirectoryCurrent: assertRootCurrent,
    mode: fileMode,
  });

  return loadStore(root);
}

/**
 * Resolve a write target without ever returning the bundled, read-only seed.
 *
 * Reading may legitimately fall back to the seed. On the first write, copy the
 * seed into the current project's .pitlore directory and write there instead.
 */
export function ensureWritableLoreRoot(
  root?: string,
  options: WritableLoreRootOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const resolved = root ?? resolveLoreRoot(cwd);
  const bundledSeed = seedDir();

  if (!isSameOrWithin(resolved, bundledSeed)) {
    const writable = path.resolve(resolved);
    if (!fs.existsSync(path.join(writable, "manifest.yaml"))) {
      initLore(writable);
      options.onCreate?.(writable);
    }
    return writable;
  }

  const project = defaultProjectLore(cwd);
  if (isSameOrWithin(project, bundledSeed)) {
    throw new Error(
      `Refusing to create writable lore inside bundled seed: ${project}`,
    );
  }

  if (!fs.existsSync(path.join(project, "manifest.yaml"))) {
    initLore(project, { copySeed: true, seedDir: bundledSeed });
    options.onCreate?.(project);
  }
  return project;
}

export function putLesson(
  root: string,
  lesson: Lesson,
  options: PutLessonOptions = {},
): string {
  const valid = prepareLessonForWrite(lesson);
  const safetyIssues = assertPublicSafe(valid);
  if (safetyIssues.length > 0) {
    throw new Error(
      `Refusing to write unsafe public lesson: ${safetyIssues.join("; ")}`,
    );
  }
  if (valid.status === "approved") {
    throw new Error(
      `Refusing to write approved lesson directly; use approveLesson: ${valid.id}`,
    );
  }
  if (valid.status === "rejected") {
    throw new Error(
      `Refusing to write rejected lesson directly; use rejectLesson: ${valid.id}`,
    );
  }
  if (valid.status === "deprecated") {
    throw new Error(
      `Refusing to write deprecated lesson directly; use deprecateLesson: ${valid.id}`,
    );
  }
  const writableRoot = ensureWritableLoreRoot(root, options);
  return withLessonWriteLock(writableRoot, valid.id, (assertDirectoryCurrent) => {
    assertDirectoryCurrent();
    const existing = getLesson(loadStore(writableRoot), valid.id);
    if (existing && existing.status !== "candidate") {
      throw new Error(
        `Cannot overwrite ${existing.status} lesson through putLesson: ${valid.id}`,
      );
    }
    return writeValidatedLesson(
      writableRoot,
      valid,
      options,
      assertDirectoryCurrent,
    );
  });
}

function prepareLessonForWrite(lesson: Lesson): Lesson {
  return validateLesson({
    ...lesson,
    updated_at: new Date().toISOString(),
    created_at: lesson.created_at ?? new Date().toISOString(),
  });
}

function writeValidatedLesson(
  root: string,
  valid: Lesson,
  options: PutLessonOptions,
  assertDirectoryCurrent: () => void = () => {},
): string {
  const safetyIssues = assertPublicSafe(valid);
  if (safetyIssues.length > 0) {
    throw new Error(
      `Refusing to write unsafe public lesson: ${safetyIssues.join("; ")}`,
    );
  }

  const writableRoot = ensureWritableLoreRoot(root, options);
  assertDirectoryCurrent();
  const file = resolveLessonWriteFile(writableRoot, valid.id);
  assertWritableFileTarget(writableRoot, file, "Lesson target");
  if (!isSameOrWithin(file, writableRoot)) {
    throw new Error(`Refusing to write lesson outside lore root: ${file}`);
  }
  if (isSameOrWithin(file, seedDir())) {
    throw new Error(`Refusing to write lesson inside bundled seed: ${file}`);
  }
  if (options.overwrite !== true && lstatIfExists(file)) {
    throw new Error(`Lesson already exists: ${valid.id}`);
  }
  try {
    writeYamlFileAtomically(file, valid, {
      exclusive: options.overwrite !== true,
      assertDirectoryCurrent,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(`Lesson already exists: ${valid.id}`);
    }
    throw error;
  }
  return file;
}

export function getLesson(store: LoreStore, id: string): Lesson | undefined {
  return store.lessons.find((l) => l.id === id);
}

export function listLessons(
  store: LoreStore,
  filter: {
    status?: Lesson["status"] | "all";
    language?: string;
    q?: string;
  } = {},
): Lesson[] {
  let items = [...store.lessons];
  if (filter.status && filter.status !== "all") {
    items = items.filter((l) => l.status === filter.status);
  }
  if (filter.language) {
    const lang = filter.language.toLowerCase();
    items = items.filter((l) =>
      l.languages.some((x) => x.toLowerCase() === lang),
    );
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    items = items.filter((l) => lessonSearchBlob(l).includes(q));
  }
  return items;
}

export function loadReviewStore(root = resolveLoreRoot()): ReviewStore {
  // A review is meaningful only beside an initialized lore store.
  loadStore(root);
  const rootIdentity = captureDirectoryIdentity(root, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(root, root, rootIdentity, "Lore root");
  const reviewsDir = path.join(root, "reviews");
  const reviews: CandidateReview[] = [];
  const loadErrors: ReviewLoadError[] = [];

  const reviewsEntry = lstatIfExists(reviewsDir);
  if (!reviewsEntry) {
    return { root, reviews, loadErrors };
  }
  if (reviewsEntry.isSymbolicLink()) {
    return {
      root,
      reviews,
      loadErrors: [
        {
          filePath: reviewsDir,
          message: "reviews directory must not be a symlink",
        },
      ],
    };
  }
  if (!isSameOrWithin(reviewsDir, root)) {
    return {
      root,
      reviews,
      loadErrors: [
        {
          filePath: reviewsDir,
          message: "reviews directory escapes the lore root",
        },
      ],
    };
  }
  const reviewsIdentity = captureDirectoryIdentity(
    reviewsDir,
    "Reviews directory",
  );
  const assertReviewsCurrent = () => {
    assertRootCurrent();
    assertSameDirectory(
      reviewsDir,
      root,
      reviewsIdentity,
      "Reviews directory",
    );
  };

  const seenIds = new Map<string, string>();
  const duplicateIds = new Set<string>();
  assertReviewsCurrent();
  for (const name of fs.readdirSync(reviewsDir).sort()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const file = path.join(reviewsDir, name);
    try {
      assertReviewsCurrent();
      const reviewEntry = fs.lstatSync(file);
      if (reviewEntry.isSymbolicLink()) {
        throw new Error("review file must not be a symlink");
      }
      if (!isSameOrWithin(file, root)) {
        throw new Error("review file escapes the lore root");
      }
      const review = validateCandidateReview(
        readYamlFile(file, {
          label: "Review file",
          assertDirectoryCurrent: assertReviewsCurrent,
          expectedFileIdentity: fileIdentity(reviewEntry),
        }),
      );
      if (path.parse(name).name !== review.lesson_id) {
        throw new Error(
          `review lesson_id ${review.lesson_id} does not match filename ${name}`,
        );
      }
      const previous = seenIds.get(review.lesson_id);
      if (previous || duplicateIds.has(review.lesson_id)) {
        const loadedIndex = reviews.findIndex(
          (loaded) => loaded.lesson_id === review.lesson_id,
        );
        if (loadedIndex >= 0) reviews.splice(loadedIndex, 1);
        duplicateIds.add(review.lesson_id);
        throw new Error(
          `duplicate review for ${review.lesson_id} also declared by ${previous ?? "another review file"}`,
        );
      }
      seenIds.set(review.lesson_id, name);
      reviews.push(review);
    } catch (error) {
      loadErrors.push({
        filePath: file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  assertReviewsCurrent();
  return { root, reviews, loadErrors };
}

export function getCandidateReview(
  store: ReviewStore,
  lessonId: string,
): CandidateReview | undefined {
  return store.reviews.find((review) => review.lesson_id === lessonId);
}

export function writeCandidateReview(
  root: string,
  review: CandidateReview,
  options: WritableLoreRootOptions = {},
): string {
  const valid = validateCandidateReview(review);
  const writableRoot = ensureWritableLoreRoot(root, options);
  const rootIdentity = captureDirectoryIdentity(writableRoot, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(
      writableRoot,
      writableRoot,
      rootIdentity,
      "Lore root",
    );
  const reviewsDir = path.join(writableRoot, "reviews");
  ensureWritableDirectory(
    writableRoot,
    reviewsDir,
    "Reviews directory",
    assertRootCurrent,
  );
  const reviewsIdentity = captureDirectoryIdentity(
    reviewsDir,
    "Reviews directory",
  );
  setDirectoryMode(
    reviewsDir,
    reviewsIdentity,
    0o700,
    "Reviews directory",
  );
  const assertReviewsCurrent = () => {
    assertRootCurrent();
    assertSameDirectory(
      reviewsDir,
      writableRoot,
      reviewsIdentity,
      "Reviews directory",
    );
  };
  const file = path.join(reviewsDir, `${valid.lesson_id}.yaml`);
  assertReviewsCurrent();
  assertWritableFileTarget(writableRoot, file, "Review target");
  if (!isSameOrWithin(file, writableRoot)) {
    throw new Error(`Refusing to write review outside lore root: ${file}`);
  }
  if (isSameOrWithin(file, seedDir())) {
    throw new Error(`Refusing to write review inside bundled seed: ${file}`);
  }
  writeYamlFileAtomically(file, valid, {
    assertDirectoryCurrent: assertReviewsCurrent,
    mode: 0o600,
  });
  return file;
}

export function getApprovalReadiness(
  root: string,
  lessonId: string,
): ApprovalReadiness {
  const store = loadStore(root);
  const lesson = getLesson(store, lessonId);
  if (!lesson) throw new Error(`Lesson not found: ${lessonId}`);
  if (lesson.status === "rejected") {
    return {
      ready: false,
      issues: [`Rejected lesson cannot be approved: ${lessonId}`],
    };
  }
  if (lesson.status === "deprecated") {
    return {
      ready: false,
      issues: [`Deprecated lesson cannot be approved: ${lessonId}`],
    };
  }

  const issues: string[] = [];
  try {
    assertLessonDetectorConfiguration(store, lesson);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (lesson.severity !== "block") {
    return { ready: issues.length === 0, issues };
  }

  try {
    assertBlockLessonFixtures(root, store, lesson);
    return { ready: issues.length === 0, issues };
  } catch (error) {
    return {
      ready: false,
      issues: [
        ...issues,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

export function getApprovalFixtureSnapshot(
  root: string,
  lessonId: string,
): ApprovalFixtureSnapshot {
  const store = loadStore(root);
  const lesson = getLesson(store, lessonId);
  if (!lesson) throw new Error(`Lesson not found: ${lessonId}`);
  const hashes: Record<string, string> = {};
  for (const kind of ["bad", "good"] as const) {
    for (const fixture of lesson.enforcement.fixtures[kind]) {
      const key = `${kind}:${fixture}`;
      try {
        const body = readApprovalFixture(root, lesson.id, kind, fixture);
        hashes[key] = createHash("sha256")
          .update(body)
          .digest("hex");
      } catch (error) {
        // Invalid paths still participate in the review context without leaking
        // their error details into the hash record.
        hashes[key] = createHash("sha256")
          .update(error instanceof Error ? error.message : String(error))
          .digest("hex");
      }
    }
  }
  return { hashes };
}

function assertLessonDetectorConfiguration(
  store: LoreStore,
  lesson: Lesson,
): void {
  const isolatedStore: LoreStore = {
    root: store.root,
    manifest: store.manifest,
    lessons: [lesson],
    loadErrors: [],
  };
  const configuration = checkContent(isolatedStore, "", {
    onlyApproved: false,
  });
  if (configuration.configurationErrors.length > 0) {
    throw new Error(
      `Cannot approve lesson ${lesson.id}: invalid detector configuration: ${configuration.configurationErrors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
}

export function lessonSearchBlob(lesson: Lesson): string {
  return [
    lesson.id,
    lesson.title,
    lesson.category,
    lesson.symptom,
    lesson.root_cause,
    lesson.forbid_pattern_abstract,
    lesson.safe_pattern_abstract,
    ...lesson.languages,
    ...lesson.ecosystems,
    ...lesson.tags,
  ]
    .join("\n")
    .toLowerCase();
}

export function approvedCatalogHash(store: LoreStore): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        store.lessons
          .filter((lesson) => lesson.status === "approved")
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest("hex");
}

export function approveLesson(
  root: string,
  id: string,
  options: WritableLoreRootOptions = {},
): Lesson {
  const writableRoot = ensureWritableLoreRoot(root, options);
  return withLessonWriteLock(writableRoot, id, (assertDirectoryCurrent) => {
    assertDirectoryCurrent();
    const store = loadStore(writableRoot);
    const lesson = getLesson(store, id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    if (lesson.status === "approved") return lesson;
    if (lesson.status === "rejected") {
      throw new Error(`Rejected lesson cannot be approved: ${id}`);
    }
    if (lesson.status === "deprecated") {
      throw new Error(`Deprecated lesson cannot be approved: ${id}`);
    }
    assertLessonDetectorConfiguration(store, lesson);
    if (lesson.severity === "block") {
      assertBlockLessonFixtures(writableRoot, store, lesson);
    }
    const next = prepareLessonForWrite(
      validateLesson({ ...lesson, status: "approved" }),
    );
    writeValidatedLesson(
      writableRoot,
      next,
      { ...options, overwrite: true },
      assertDirectoryCurrent,
    );
    return next;
  });
}

export function rejectLesson(
  root: string,
  id: string,
  options: WritableLoreRootOptions = {},
): Lesson {
  const writableRoot = ensureWritableLoreRoot(root, options);
  return withLessonWriteLock(writableRoot, id, (assertDirectoryCurrent) => {
    assertDirectoryCurrent();
    const store = loadStore(writableRoot);
    const lesson = getLesson(store, id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    if (lesson.status === "rejected") return lesson;
    if (lesson.status === "approved") {
      throw new Error(`Approved lesson cannot be rejected: ${id}`);
    }
    if (lesson.status === "deprecated") {
      throw new Error(`Deprecated lesson cannot be rejected: ${id}`);
    }
    const next = prepareLessonForWrite(
      validateLesson({ ...lesson, status: "rejected" }),
    );
    writeValidatedLesson(
      writableRoot,
      next,
      { ...options, overwrite: true },
      assertDirectoryCurrent,
    );
    return next;
  });
}

export function deprecateLesson(
  root: string,
  id: string,
  options: WritableLoreRootOptions = {},
): Lesson {
  const writableRoot = ensureWritableLoreRoot(root, options);
  return withLessonWriteLock(writableRoot, id, (assertDirectoryCurrent) => {
    assertDirectoryCurrent();
    const store = loadStore(writableRoot);
    const lesson = getLesson(store, id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    if (lesson.status === "deprecated") return lesson;
    if (lesson.status === "candidate") {
      throw new Error(
        `Candidate lesson cannot be deprecated; approve or reject it instead: ${id}`,
      );
    }
    if (lesson.status === "rejected") {
      throw new Error(`Rejected lesson cannot be deprecated: ${id}`);
    }
    const next = prepareLessonForWrite(
      validateLesson({ ...lesson, status: "deprecated" }),
    );
    writeValidatedLesson(
      writableRoot,
      next,
      { ...options, overwrite: true },
      assertDirectoryCurrent,
    );
    return next;
  });
}

function withLessonWriteLock<T>(
  root: string,
  lessonId: string,
  operation: (assertDirectoryCurrent: () => void) => T,
): T {
  LessonIdSchema.parse(lessonId);
  const rootIdentity = captureDirectoryIdentity(root, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(root, root, rootIdentity, "Lore root");
  const lessonsDir = path.join(root, "lessons");
  if (isSameOrWithin(lessonsDir, seedDir())) {
    throw new Error(`Refusing to write lesson inside bundled seed: ${lessonsDir}`);
  }
  ensureWritableDirectory(
    root,
    lessonsDir,
    "Lessons directory",
    assertRootCurrent,
  );
  if (!isSameOrWithin(lessonsDir, root)) {
    throw new Error(`Lessons directory escapes the lore root: ${lessonsDir}`);
  }
  const directoryIdentity = captureDirectoryIdentity(
    lessonsDir,
    "Lessons directory",
  );
  const assertDirectoryCurrent = () => {
    assertRootCurrent();
    assertSameDirectory(
      lessonsDir,
      root,
      directoryIdentity,
      "Lessons directory",
    );
  };
  const lockHash = createHash("sha256").update(lessonId).digest("hex");
  const lock = path.join(lessonsDir, `.pitlore-lock-${lockHash}.lock`);
  if (!isSameOrWithin(lock, lessonsDir)) {
    throw new Error(`Lesson write lock escapes the lore root: ${lock}`);
  }
  assertNotSymbolicLink(lock, "Lesson write lock");
  assertDirectoryCurrent();
  const descriptor = openLessonWriteLock(lock, lessonId);
  const lockIdentity = fs.fstatSync(descriptor);
  let primaryError: unknown;
  let result: T | undefined;
  try {
    assertDirectoryCurrent();
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
      "utf8",
    );
    fs.fsyncSync(descriptor);
    assertDirectoryCurrent();
    result = operation(assertDirectoryCurrent);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: string[] = [];
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    assertDirectoryCurrent();
    const currentLock = lstatIfExists(lock);
    if (currentLock) {
      if (
        currentLock.isSymbolicLink() ||
        currentLock.dev !== lockIdentity.dev ||
        currentLock.ino !== lockIdentity.ino
      ) {
        throw new Error(`Lesson write lock changed before cleanup: ${lock}`);
      }
      fs.unlinkSync(lock);
    }
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (primaryError !== undefined) {
    throwWithCleanupContext(
      primaryError,
      cleanupErrors,
      `lock cleanup also failed at ${lock}`,
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      `Lesson ${lessonId} write may have completed but lock cleanup failed at ${lock}: ${cleanupErrors.join("; ")}`,
    );
  }
  return result as T;
}

function assertBlockLessonFixtures(
  root: string,
  store: LoreStore,
  lesson: Lesson,
): void {
  const patterns = lesson.enforcement.patterns;
  if (patterns.length === 0 || patterns.some((pattern) => pattern.trim() === "")) {
    throw new Error(
      `Cannot approve block lesson ${lesson.id}: at least one non-empty declarative pattern is required`,
    );
  }

  const fixtures = lesson.enforcement.fixtures;
  if (fixtures.bad.length === 0 || fixtures.good.length === 0) {
    throw new Error(
      `Cannot approve block lesson ${lesson.id}: at least one bad and one good fixture are required`,
    );
  }

  // check.ts only imports LoreStore as a type, so using the shared detector here
  // does not introduce a runtime cycle. Isolating the lesson prevents unrelated
  // lore configuration from deciding whether this candidate can be approved.
  const fixtureStore: LoreStore = {
    root,
    manifest: store.manifest,
    lessons: [lesson],
    loadErrors: [],
  };
  for (const fixture of fixtures.bad) {
    const fixtureBody = readApprovalFixture(root, lesson.id, "bad", fixture);
    const result = checkContent(
      fixtureStore,
      fixtureBody,
      { onlyApproved: false },
    );
    if (result.configurationErrors.length > 0) {
      throw new Error(
        `Cannot approve block lesson ${lesson.id}: invalid detector configuration: ${result.configurationErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    if (result.findings.length === 0) {
      throw new Error(
        `Cannot approve block lesson ${lesson.id}: bad fixture was not detected: ${fixture}`,
      );
    }
  }

  for (const fixture of fixtures.good) {
    const fixtureBody = readApprovalFixture(root, lesson.id, "good", fixture);
    const result = checkContent(
      fixtureStore,
      fixtureBody,
      { onlyApproved: false },
    );
    if (result.configurationErrors.length > 0) {
      throw new Error(
        `Cannot approve block lesson ${lesson.id}: invalid detector configuration: ${result.configurationErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    if (!result.clean) {
      throw new Error(
        `Cannot approve block lesson ${lesson.id}: good fixture triggered the detector: ${fixture}`,
      );
    }
  }
}

function readApprovalFixture(
  root: string,
  lessonId: string,
  kind: "bad" | "good",
  fixture: string,
): string {
  if (path.isAbsolute(fixture) || path.win32.isAbsolute(fixture)) {
    throw new Error(
      `Cannot approve block lesson ${lessonId}: ${kind} fixture path must be relative to the lore root: ${fixture}`,
    );
  }

  const fixturePath = path.resolve(root, fixture);
  if (!isSameOrWithin(fixturePath, root)) {
    throw new Error(
      `Cannot approve block lesson ${lessonId}: ${kind} fixture escapes the lore root: ${fixture}`,
    );
  }
  const rootIdentity = captureDirectoryIdentity(root, "Lore root");
  const assertRootCurrent = () =>
    assertSameDirectory(root, root, rootIdentity, "Lore root");
  assertRootCurrent();
  const relative = path.relative(root, fixturePath);
  const segments = relative.split(path.sep);
  let current = root;
  let fixtureEntry: fs.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = lstatIfExists(current);
    const final = index === segments.length - 1;
    if (!entry) {
      throw new Error(
        final
          ? `Cannot approve block lesson ${lessonId}: ${kind} fixture does not exist or is not a file: ${fixture}`
          : `Cannot approve block lesson ${lessonId}: ${kind} fixture path contains a missing component: ${fixture}`,
      );
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Cannot approve block lesson ${lessonId}: ${kind} fixture path contains a symbolic-link component: ${fixture}`,
      );
    }
    if (!final && !entry.isDirectory()) {
      throw new Error(
        `Cannot approve block lesson ${lessonId}: ${kind} fixture path component is not a directory: ${fixture}`,
      );
    }
    if (final) fixtureEntry = entry;
  }
  if (!fixtureEntry?.isFile()) {
    throw new Error(
      `Cannot approve block lesson ${lessonId}: ${kind} fixture does not exist or is not a file: ${fixture}`,
    );
  }
  assertRootCurrent();
  return readTextFileNoFollow(fixturePath, {
    label: `${kind} fixture`,
    assertDirectoryCurrent: assertRootCurrent,
    expectedFileIdentity: fileIdentity(fixtureEntry),
  });
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertNotSymbolicLink(filePath: string, label: string): void {
  if (lstatIfExists(filePath)?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${filePath}`);
  }
}

function assertWritableFileTarget(
  root: string,
  filePath: string,
  label: string,
): void {
  assertNotSymbolicLink(filePath, label);
  if (!isSameOrWithin(filePath, root)) {
    throw new Error(`${label} escapes the lore root: ${filePath}`);
  }
}

function resolveLessonWriteFile(root: string, lessonId: string): string {
  const lessonsDir = path.join(root, "lessons");
  const candidates = [
    path.join(lessonsDir, `${lessonId}.yaml`),
    path.join(lessonsDir, `${lessonId}.yml`),
  ];
  const existing = candidates.filter((candidate) => lstatIfExists(candidate));
  if (existing.length > 1) {
    throw new Error(
      `Multiple lesson files exist for ${lessonId}: ${existing.join(", ")}`,
    );
  }
  return existing[0] ?? candidates[0]!;
}

function ensureWritableDirectory(
  root: string,
  directory: string,
  label: string,
  assertParentCurrent: () => void = () => {},
): void {
  assertParentCurrent();
  const entry = lstatIfExists(directory);
  if (entry?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${directory}`);
  }
  if (entry && !entry.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
  if (!isSameOrWithin(directory, root)) {
    throw new Error(`${label} escapes the lore root: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertParentCurrent();
  const created = fs.lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
  if (!isSameOrWithin(directory, root)) {
    throw new Error(`${label} escapes the lore root: ${directory}`);
  }
  assertParentCurrent();
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface DirectoryIdentity extends FileIdentity {}

function fileIdentity(entry: fs.Stats): FileIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function throwWithCleanupContext(
  primaryError: unknown,
  cleanupErrors: string[],
  label: string,
): never {
  if (cleanupErrors.length === 0) throw primaryError;
  const suffix = `${label}: ${cleanupErrors.join("; ")}`;
  if (primaryError instanceof Error) {
    primaryError.message = `${primaryError.message}; ${suffix}`;
    throw primaryError;
  }
  throw new Error(`${String(primaryError)}; ${suffix}`);
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | noFollow | directoryOnly,
    );
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function setDirectoryMode(
  directory: string,
  expected: DirectoryIdentity,
  mode: number,
  label: string,
): void {
  if (process.platform === "win32") return;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | noFollow | directoryOnly,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isDirectory() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new Error(`${label} changed before permission update: ${directory}`);
    }
    fs.fchmodSync(descriptor, mode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSameFile(
  filePath: string,
  expected: FileIdentity,
  label: string,
): void {
  const entry = fs.lstatSync(filePath);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.dev !== expected.dev ||
    entry.ino !== expected.ino
  ) {
    throw new Error(`${label} changed during filesystem operation: ${filePath}`);
  }
}

function captureDirectoryIdentity(
  directory: string,
  label: string,
): DirectoryIdentity {
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
  return { dev: entry.dev, ino: entry.ino };
}

function assertSameDirectory(
  directory: string,
  root: string,
  expected: DirectoryIdentity,
  label: string,
): void {
  const entry = fs.lstatSync(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.dev !== expected.dev ||
    entry.ino !== expected.ino ||
    !isSameOrWithin(directory, root)
  ) {
    throw new Error(`${label} changed during filesystem operation: ${directory}`);
  }
}

function openLessonWriteLock(lock: string, lessonId: string): number {
  try {
    return fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(
        `Lesson write already in progress: ${lessonId}. Lock: ${lock}. ` +
          "PitLore never auto-removes locks; inspect its PID and verify the process has exited before manual recovery.",
      );
    }
    throw error;
  }
}

function isSameOrWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function canonicalPath(filePath: string): string {
  let current = path.resolve(filePath);
  const missingSegments: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(filePath);
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  const real = fs.realpathSync.native(current);
  return path.join(real, ...missingSegments);
}
