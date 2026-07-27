import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateLesson } from "../src/schema.js";
import {
  approveLesson,
  getLesson,
  initLore,
  loadStore,
  putLesson,
} from "../src/store.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const seed = path.join(repoRoot, "seed");
const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("lore store path safety", () => {
  it("preflights a lessons-directory symlink before copying seed files", () => {
    const root = makeTempRoot("pitlore-init-symlink-");
    const outside = makeTempRoot("pitlore-init-outside-");
    fs.symlinkSync(outside, path.join(root, "lessons"), "dir");

    expect(() =>
      initLore(root, { copySeed: true, seedDir: seed }),
    ).toThrow("Lessons directory must not be a symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(false);
  });

  it.each([
    ["manifest.yaml", "Lore manifest"],
    ["README.md", "Lore README"],
  ])("does not initialize through a dangling %s symlink", (name, label) => {
    const root = makeTempRoot("pitlore-init-file-symlink-");
    const outside = makeTempRoot("pitlore-init-file-outside-");
    const outsideFile = path.join(outside, `${name}.created`);
    fs.symlinkSync(outsideFile, path.join(root, name));

    expect(() => initLore(root)).toThrow(`${label} must not be a symlink`);
    expect(fs.existsSync(outsideFile)).toBe(false);
    expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
  });

  it("does not copy a seed lesson through a dangling target symlink", () => {
    const root = makeTempRoot("pitlore-init-seed-symlink-");
    const outside = makeTempRoot("pitlore-init-seed-outside-");
    const lessons = path.join(root, "lessons");
    fs.mkdirSync(lessons);
    const outsideFile = path.join(outside, "seed-created.yaml");
    fs.symlinkSync(
      outsideFile,
      path.join(lessons, "js-foreach-async-await-miss.yaml"),
    );

    expect(() =>
      initLore(root, { copySeed: true, seedDir: seed }),
    ).toThrow("Seed lesson target must not be a symlink");
    expect(fs.existsSync(outsideFile)).toBe(false);
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(false);
  });

  it("rejects or platform-prevents a lessons-directory identity swap before atomic replacement", () => {
    const root = makeTempRoot("pitlore-write-swap-");
    const outside = makeTempRoot("pitlore-write-swap-outside-");
    initLore(root);
    const lesson = validateLesson({
      id: "directory-swap-candidate",
      title: "Directory identity remains stable",
      languages: ["typescript"],
      category: "filesystem",
      symptom: "A concurrent path swap could redirect a lifecycle write",
      root_cause: "Containment was checked before the final filesystem operation",
      forbid_pattern_abstract: "Trusting a mutable directory path after one check",
      safe_pattern_abstract: "Pin and recheck directory identity around atomic writes",
    });
    putLesson(root, lesson);
    const lessons = path.join(root, "lessons");
    const target = path.join(lessons, `${lesson.id}.yaml`);
    const outsideTarget = path.join(outside, `${lesson.id}.yaml`);
    fs.copyFileSync(target, outsideTarget);
    const movedLessons = path.join(root, "lessons-before-swap");
    const originalStat = fs.statSync.bind(fs);
    let swapped = false;
    let swapPreventedByPlatform = false;
    vi.spyOn(fs, "statSync").mockImplementation(((filePath, options) => {
      if (!swapped && path.resolve(String(filePath)) === path.resolve(target)) {
        swapped = true;
        try {
          fs.renameSync(lessons, movedLessons);
        } catch (error) {
          if (
            process.platform === "win32" &&
            (error as NodeJS.ErrnoException).code === "EPERM"
          ) {
            swapPreventedByPlatform = true;
          }
          throw error;
        }
        fs.symlinkSync(outside, lessons, "dir");
      }
      return originalStat(filePath, options as never);
    }) as typeof fs.statSync);

    let approvalError: unknown;
    try {
      approveLesson(root, lesson.id);
    } catch (error) {
      approvalError = error;
    }

    expect(swapped).toBe(true);
    expect(approvalError).toBeInstanceOf(Error);
    if (swapPreventedByPlatform) {
      expect((approvalError as NodeJS.ErrnoException).code).toBe("EPERM");
    } else {
      expect((approvalError as Error).message).toContain(
        "Lessons directory changed during filesystem operation",
      );
    }
    expect(fs.readFileSync(outsideTarget, "utf8")).toContain("status: candidate");
    expect(fs.readFileSync(target, "utf8")).toContain("status: candidate");
  });

  it("does not rename or unlink a replacement atomic temporary file", () => {
    const root = makeTempRoot("pitlore-temp-identity-");
    initLore(root);
    const lesson = validateLesson({
      id: "temporary-file-identity",
      title: "Verify temporary files before replacement",
      languages: ["typescript"],
      category: "filesystem",
      symptom: "A temporary filename was replaced before rename",
      root_cause: "Cleanup trusted the temporary path instead of its inode",
      forbid_pattern_abstract: "Rename or unlink an unverified temporary pathname",
      safe_pattern_abstract: "Compare the temporary entry with the opened descriptor",
    });
    putLesson(root, lesson);
    const lessons = path.join(root, "lessons");
    const target = path.join(lessons, `${lesson.id}.yaml`);
    const originalFsync = fs.fsyncSync.bind(fs);
    let replacement: string | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      originalFsync(descriptor);
      if (!replacement) {
        const temporary = fs
          .readdirSync(lessons)
          .find((name) => name.startsWith(".pitlore-write-"));
        if (temporary) {
          replacement = path.join(lessons, temporary);
          fs.renameSync(replacement, `${replacement}.original`);
          fs.writeFileSync(replacement, "replacement", { mode: 0o600 });
        }
      }
    });

    expect(() => approveLesson(root, lesson.id)).toThrow(
      "Atomic temporary file changed during filesystem operation",
    );
    expect(fs.readFileSync(target, "utf8")).toContain("status: candidate");
    expect(replacement && fs.readFileSync(replacement, "utf8")).toBe(
      "replacement",
    );
  });

  it("pins the lore root while initialization writes its commit marker", () => {
    const root = makeTempRoot("pitlore-init-root-swap-");
    const outside = makeTempRoot("pitlore-init-root-swap-outside-");
    const movedRoot = `${root}-before-swap`;
    const manifest = path.join(root, "manifest.yaml");
    const originalStat = fs.statSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "statSync").mockImplementation(((filePath, options) => {
      if (!swapped && path.resolve(String(filePath)) === path.resolve(manifest)) {
        swapped = true;
        fs.renameSync(root, movedRoot);
        fs.symlinkSync(outside, root, "dir");
      }
      return originalStat(filePath, options as never);
    }) as typeof fs.statSync);

    expect(() => initLore(root)).toThrow(
      "Lore root changed during filesystem operation",
    );
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.unlinkSync(root);
    fs.renameSync(movedRoot, root);
  });

  it("does not load a transient parent-directory substitution", () => {
    const root = makeTempRoot("pitlore-load-swap-");
    const outside = makeTempRoot("pitlore-load-swap-outside-");
    initLore(root);
    const lesson = validateLesson({
      id: "transient-load-substitution",
      title: "Read the file that was inspected",
      languages: ["typescript"],
      category: "filesystem",
      symptom: "A transient directory swap injects a different lesson",
      root_cause: "The opened descriptor was not matched to the inspected inode",
      forbid_pattern_abstract: "Trust a path across separate lstat and read calls",
      safe_pattern_abstract: "Open without following links and verify descriptor identity",
    });
    putLesson(root, lesson);
    const lessons = path.join(root, "lessons");
    const movedLessons = path.join(root, "lessons-before-transient-swap");
    const target = path.join(lessons, `${lesson.id}.yaml`);
    fs.writeFileSync(
      path.join(outside, `${lesson.id}.yaml`),
      JSON.stringify({ ...lesson, status: "approved" }),
      "utf8",
    );
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (!swapped && path.resolve(String(filePath)) === path.resolve(target)) {
        swapped = true;
        fs.renameSync(lessons, movedLessons);
        fs.symlinkSync(outside, lessons, "dir");
        try {
          return originalOpen(filePath, flags, mode as never);
        } finally {
          fs.unlinkSync(lessons);
          fs.renameSync(movedLessons, lessons);
        }
      }
      return originalOpen(filePath, flags, mode as never);
    }) as typeof fs.openSync);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = loadStore(root);
    expect(getLesson(store, lesson.id)).toBeUndefined();
    expect(store.loadErrors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("changed during read") }),
    ]);
    expect(fs.readFileSync(target, "utf8")).toContain("status: candidate");
  });

  it("uses a final manifest commit marker so failed initialization can retry", () => {
    const root = makeTempRoot("pitlore-init-retry-");
    const brokenSeed = makeTempRoot("pitlore-broken-seed-");
    const seedLessons = path.join(brokenSeed, "lessons");
    fs.mkdirSync(seedLessons);
    fs.mkdirSync(path.join(seedLessons, "not-a-file.yaml"));

    expect(() =>
      initLore(root, { copySeed: true, seedDir: brokenSeed }),
    ).toThrow();
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(false);

    expect(initLore(root, { copySeed: false }).manifest.name).toContain("/lore");
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(true);
  });

  it("creates a private lore with owner-only filesystem permissions", () => {
    if (process.platform === "win32") return;
    const parent = makeTempRoot("pitlore-private-mode-");
    const root = path.join(parent, "lore");
    const previousUmask = process.umask(0o022);
    try {
      initLore(root);
      putLesson(
        root,
        validateLesson({
          id: "private-mode-default",
          title: "Private files are owner-only",
          languages: ["typescript"],
          category: "privacy",
          symptom: "Other local users can read private lessons",
          root_cause: "Files inherited permissive process defaults",
          forbid_pattern_abstract: "Create private lore with default modes",
          safe_pattern_abstract: "Use explicit owner-only modes",
        }),
      );
    } finally {
      process.umask(previousUmask);
    }

    expect(mode(root)).toBe(0o700);
    expect(mode(path.join(root, "lessons"))).toBe(0o700);
    expect(mode(path.join(root, "manifest.yaml"))).toBe(0o600);
    expect(mode(path.join(root, "README.md"))).toBe(0o600);
    expect(mode(path.join(root, "lessons", "private-mode-default.yaml"))).toBe(
      0o600,
    );
  });

  it("syncs the parent directory after atomic replacement where supported", () => {
    if (process.platform === "win32") return;
    const root = makeTempRoot("pitlore-directory-fsync-");
    initLore(root);
    const originalFsync = fs.fsyncSync.bind(fs);
    let directorySyncs = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) directorySyncs += 1;
      originalFsync(descriptor);
    });

    putLesson(
      root,
      validateLesson({
        id: "directory-metadata-sync",
        title: "Sync atomic directory metadata",
        languages: ["typescript"],
        category: "filesystem",
        symptom: "A rename was visible but not durable after power loss",
        root_cause: "Only the temporary file was synchronized",
        forbid_pattern_abstract: "Fsync a file but not its renamed directory entry",
        safe_pattern_abstract: "Fsync the containing directory after atomic replacement",
      }),
    );

    expect(directorySyncs).toBeGreaterThan(0);
  });
});

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}
