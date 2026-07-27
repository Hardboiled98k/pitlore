import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import semver from "semver";
import { z } from "zod";
import { resolveLoreRoot } from "./paths.js";
import {
  findSensitiveInputIssues,
  PackNameSchema,
  SemverSchema,
  type Lesson,
} from "./schema.js";
import {
  getApprovalReadiness,
  loadStore,
  type LoreStore,
} from "./store.js";

const MAX_PACK_FILES = 1_000;
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024;
const SHA256_INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/;
const GIT_COMMIT = /^[a-f0-9]{40,64}$/;
const KEY_ID = /^sha256-[a-f0-9]{64}$/;
const PACK_SIGNATURE_FILE = "SIGNATURE.json";
const PACK_LOCK_WAIT_TIMEOUT_MS = 30_000;
const PACK_LOCK_RETRY_MS = 25;
const PACK_GIT_TIMEOUT_MS = 120_000;
const PACK_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PACK_GIT_MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const PACK_GIT_TRANSFER_POLL_MS = 150;
const PACK_GIT_WATCHDOG_MARKER = "pitlore-git-watchdog";
const PACK_GIT_WATCHDOG_BAD_ARGS_EXIT = 96;
const PACK_GIT_TRANSFER_CAP_EXIT = 97;
const PACK_GIT_WATCHDOG_TIMEOUT_EXIT = 98;

// Runs inside `node -e` so the synchronous Pack install flow gains an async
// supervisor: git cannot observe it, and on-disk growth of the clone directory
// becomes a hard fail-closed budget instead of an unbounded stream.
const PACK_GIT_WATCHDOG_SOURCE = `"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const marker = process.argv.indexOf(${JSON.stringify(PACK_GIT_WATCHDOG_MARKER)});
const rest = marker < 0 ? [] : process.argv.slice(marker + 1);
const watchDir = rest[0];
const capBytes = Number(rest[1]);
const timeoutMs = Number(rest[2]);
const pollMs = Number(rest[3]);
const command = rest[4];
const commandArgs = rest.slice(5);
if (
  !watchDir ||
  !Number.isInteger(capBytes) || capBytes <= 0 ||
  !Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
  !Number.isInteger(pollMs) || pollMs <= 0 ||
  !command
) {
  console.error("pitlore git watchdog: invalid arguments");
  process.exit(${PACK_GIT_WATCHDOG_BAD_ARGS_EXIT});
}
// stderr stays a private pipe: grandchildren (for example git-remote-https)
// must never inherit the supervisor's own stdio, or a leaked descendant keeps
// the synchronous parent blocked long after git itself is gone.
const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
let stderrBytes = 0;
const stderrChunks = [];
child.stderr.on("data", (chunk) => {
  if (stderrBytes >= 65536) return;
  const slice = chunk.subarray(0, 65536 - stderrBytes);
  stderrBytes += slice.length;
  stderrChunks.push(slice);
});
let verdict = null;
let escalation = null;
const settle = (code) => {
  if (verdict !== null) return;
  verdict = code;
  clearInterval(poller);
  clearTimeout(timer);
  // SIGTERM first so git can tear down its own transport helpers; SIGKILL is
  // reserved for a child that ignores the polite request.
  try { child.kill("SIGTERM"); } catch {}
  escalation = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 2000);
};
const directoryBytes = (target) => {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try { total += fs.lstatSync(full).size; } catch {}
    }
  }
  return total;
};
const poller = setInterval(() => {
  if (directoryBytes(watchDir) > capBytes) settle(${PACK_GIT_TRANSFER_CAP_EXIT});
}, pollMs);
const timer = setTimeout(() => settle(${PACK_GIT_WATCHDOG_TIMEOUT_EXIT}), timeoutMs);
child.on("error", () => settle(1));
child.on("exit", (code, signal) => {
  clearInterval(poller);
  clearTimeout(timer);
  if (escalation !== null) clearTimeout(escalation);
  if (verdict === null) verdict = code === null ? (signal ? 1 : 0) : code;
  if (stderrChunks.length > 0) {
    try { fs.writeSync(2, Buffer.concat(stderrChunks)); } catch {}
  }
  process.exit(verdict);
});
`;
const PACK_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const PackSignatureFileSchema = z
  .object({
    version: z.literal("0.1.0"),
    algorithm: z.literal("ed25519"),
    key_id: z.string().regex(KEY_ID),
    public_key_spki: z.string().min(1),
    integrity: z.string().regex(SHA256_INTEGRITY),
    signature: z.string().min(1),
  })
  .strict();

const PackSignatureStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unverified") }).strict(),
  z
    .object({
      status: z.literal("verified"),
      algorithm: z.literal("ed25519"),
      key_id: z.string().regex(KEY_ID),
      identity_trust: z.enum(["self-asserted", "explicit-key"]),
    })
    .strict(),
]);

const GitSourceSchema = z
  .object({
    type: z.literal("git"),
    url: z.string().min(1).max(2_000),
    ref: z.string().min(1).max(256).nullable(),
    commit: z.string().regex(GIT_COMMIT),
    subdir: z.string().min(1).max(256).nullable().default(null),
  })
  .strict();

const LocalSourceSchema = z
  .object({
    type: z.literal("local"),
    path: z.string().min(1).max(1_000),
    tree: z.string().regex(SHA256_INTEGRITY),
  })
  .strict();

const RegistrySourceSchema = z
  .object({
    type: z.literal("registry"),
    url: z.string().min(1).max(2_000),
    org_id: z.string().uuid().nullable(),
  })
  .strict();

const AirgapSourceSchema = z.object({ type: z.literal("airgap") }).strict();

export const PackLockEntrySchema = z
  .object({
    version: SemverSchema,
    integrity: z.string().regex(SHA256_INTEGRITY),
    cache_digest: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.discriminatedUnion("type", [
      GitSourceSchema,
      LocalSourceSchema,
      RegistrySourceSchema,
      AirgapSourceSchema,
    ]),
    signature: PackSignatureStatusSchema,
    dependencies: z.record(PackNameSchema, SemverSchema),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.source.type === "git") {
      try {
        if (validateGitUrl(entry.source.url) !== entry.source.url) {
          throw new Error("Git source URL is not canonical");
        }
        if (entry.source.subdir !== null) {
          normalizePackSubdirectory(entry.source.subdir);
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source", "url"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (entry.source.type === "local") {
      try {
        normalizeRelativePackPath(entry.source.path);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source", "path"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (entry.source.type === "registry") {
      try {
        if (validateRegistryUrl(entry.source.url) !== entry.source.url) {
          throw new Error("Registry source URL is not canonical");
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source", "url"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

export const PackLockSchema = z
  .object({
    lockfile_version: z.literal(1),
    roots: z.array(PackNameSchema),
    packages: z.record(PackNameSchema, PackLockEntrySchema),
  })
  .strict()
  .superRefine((lock, context) => {
    if (new Set(lock.roots).size !== lock.roots.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roots"],
        message: "Pack lock roots must be unique",
      });
    }
  });

export type PackLockEntry = z.infer<typeof PackLockEntrySchema>;
export type PackLock = z.infer<typeof PackLockSchema>;
export type PackSignatureStatus = z.infer<typeof PackSignatureStatusSchema>;

export interface VerifiedPack {
  root: string;
  store: LoreStore;
  files: string[];
  integrity: string;
  digestHex: string;
  signature: PackSignatureStatus;
}

export interface VerifyPackOptions {
  /** Public is the Git/community default; Registry and air-gap paths may opt in to private. */
  visibility?: "public" | "private" | "either";
}

export interface InstallPackOptions {
  loreRoot?: string;
  ref?: string;
  subdir?: string;
  trustedKeyIds?: string[];
}

export interface InstallRegistryPackOptions extends InstallPackOptions {
  registryUrl: string;
  orgId?: string | null;
}

export type InstallAirgapPackOptions = InstallPackOptions;

export interface InstallAirgapPackBundleOptions {
  loreRoot?: string;
  trustedKeyIds?: string[];
}

export interface InstalledPack {
  name: string;
  version: string;
  integrity: string;
  lockPath: string;
  cachePath: string;
  created: boolean;
  updated: boolean;
}

export function uninstallPack(
  name: string,
  loreRoot = resolveLoreRoot(),
): PackLock {
  const validName = PackNameSchema.parse(name);
  const root = path.resolve(loreRoot);
  return withPackLockMutation(root, (lockPath, guard) => {
    const lock = loadPackLock(root);
    if (!lock.packages[validName]) {
      throw new Error(`Pack is not installed: ${validName}`);
    }
    const dependent = Object.entries(lock.packages).find(
      ([packageName, entry]) =>
        packageName !== validName && entry.dependencies[validName] !== undefined,
    );
    if (dependent) {
      throw new Error(`Cannot uninstall ${validName}; required by ${dependent[0]}`);
    }
    const packages = { ...lock.packages };
    delete packages[validName];
    const next = PackLockSchema.parse({
      lockfile_version: 1,
      roots: lock.roots.filter((rootName) => rootName !== validName),
      packages,
    });
    validateDependencyGraph(next);
    writePackLockUnderGuard(lockPath, next, guard);
    return next;
  });
}

export function resolvePackLockPath(loreRoot = resolveLoreRoot()): string {
  return path.basename(path.resolve(loreRoot)) === ".pitlore"
    ? path.join(path.dirname(path.resolve(loreRoot)), "pitlore.lock.yaml")
    : path.join(path.resolve(loreRoot), "pitlore.lock.yaml");
}

export function verifyPack(
  packRoot: string,
  options: VerifyPackOptions = {},
): VerifiedPack {
  const root = path.resolve(packRoot);
  const rootEntry = fs.lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`Pack root must be a real directory: ${root}`);
  }
  // Enforce the file-count and byte budgets before YAML parsing or Lesson
  // loading. Remote Git content is untrusted, and parsing an oversized file
  // must not spend memory before the Pack boundary rejects it.
  const files = enumeratePackFiles(root);
  const store = loadStore(root);
  if (store.loadErrors.length > 0) {
    throw new Error(
      `Pack contains invalid lessons: ${store.loadErrors.map((item) => `${path.basename(item.filePath)}: ${item.message}`).join("; ")}`,
    );
  }
  const visibility = options.visibility ?? "public";
  if (
    visibility !== "either" &&
    store.manifest.visibility !== visibility
  ) {
    throw new Error(
      `Pack manifest must be ${visibility}: ${store.manifest.name}`,
    );
  }
  if (store.lessons.length === 0) {
    throw new Error(`Pack must contain at least one Lesson: ${store.manifest.name}`);
  }
  for (const lesson of store.lessons) {
    if (
      !["approved", "deprecated"].includes(lesson.status) ||
      lesson.visibility !== store.manifest.visibility
    ) {
      throw new Error(
        `Pack Lesson must be approved/deprecated and ${store.manifest.visibility}: ${lesson.id}`,
      );
    }
    if (lesson.enforcement.detector_ref !== null) {
      throw new Error(
        `Pack Lesson detector_ref is not supported; use embedded declarative patterns: ${lesson.id}`,
      );
    }
    if (lesson.status === "approved") {
      const readiness = getApprovalReadiness(root, lesson.id);
      if (!readiness.ready) {
        throw new Error(
          `Pack Lesson failed detector/fixture validation: ${lesson.id}: ${readiness.issues.join("; ")}`,
        );
      }
    }
  }

  const allowed = allowedPackFiles(store.lessons);
  for (const file of files) {
    if (!allowed.has(file)) {
      throw new Error(`Pack contains an unsupported file: ${file}`);
    }
  }
  for (const required of allowed) {
    if (
      ["README.md", "CHANGELOG.md", "LICENSE", PACK_SIGNATURE_FILE].includes(
        required,
      )
    ) continue;
    if (!files.includes(required)) {
      throw new Error(`Pack references a missing file: ${required}`);
    }
  }
  if (store.manifest.visibility === "public") {
    assertPublicPackPayloadSafe(root, files);
  }
  const digest = hashPackFiles(
    root,
    files.filter((file) => file !== PACK_SIGNATURE_FILE),
  );
  const artifactDigest = hashPackFiles(root, files);
  const integrity = `sha256-${digest.base64}`;
  return {
    root,
    store,
    files,
    integrity,
    digestHex: artifactDigest.hex,
    signature: verifyPackSignature(root, integrity, files),
  };
}

export function installPack(
  source: string,
  options: InstallPackOptions = {},
): InstalledPack {
  const loreRoot = path.resolve(options.loreRoot ?? resolveLoreRoot());
  ensureRealDirectory(loreRoot, "Lore root");
  const lockPath = resolvePackLockPath(loreRoot);
  const projectRoot = path.dirname(lockPath);
  const acquired = acquirePackSource(
    source,
    projectRoot,
    options.ref,
    options.subdir,
  );
  try {
    const verified = verifyPack(acquired.root);
    return installVerifiedPack(
      verified,
      loreRoot,
      acquired.provenance(verified.integrity),
      options.trustedKeyIds ?? [],
    );
  } finally {
    acquired.cleanup();
  }
}

export function installRegistryPack(
  packRoot: string,
  options: InstallRegistryPackOptions,
): InstalledPack {
  const loreRoot = path.resolve(options.loreRoot ?? resolveLoreRoot());
  ensureRealDirectory(loreRoot, "Lore root");
  if (options.ref) throw new Error("Registry Pack install does not accept a Git ref");
  const orgId = options.orgId ?? null;
  if (orgId !== null) z.string().uuid().parse(orgId);
  return installVerifiedPack(
    verifyPack(packRoot, { visibility: "either" }),
    loreRoot,
    {
      type: "registry",
      url: validateRegistryUrl(options.registryUrl),
      org_id: orgId,
    },
    options.trustedKeyIds ?? [],
  );
}

export function installAirgapPack(
  packRoot: string,
  options: InstallAirgapPackOptions = {},
): InstalledPack {
  const loreRoot = path.resolve(options.loreRoot ?? resolveLoreRoot());
  ensureRealDirectory(loreRoot, "Lore root");
  if (options.ref) throw new Error("Air-gap Pack install does not accept a Git ref");
  return installVerifiedPack(
    verifyPack(packRoot, { visibility: "either" }),
    loreRoot,
    { type: "airgap" },
    options.trustedKeyIds ?? [],
  );
}

/** Install one complete dependency closure and commit the lockfile once. */
export function installAirgapPackBundle(
  packRoots: readonly string[],
  rootName: string,
  options: InstallAirgapPackBundleOptions = {},
): InstalledPack[] {
  const loreRoot = path.resolve(options.loreRoot ?? resolveLoreRoot());
  ensureRealDirectory(loreRoot, "Lore root");
  const validRootName = PackNameSchema.parse(rootName);
  const verifiedPacks = verifyAirgapPackBundle(packRoots, validRootName);

  return withPackLockMutation(loreRoot, (lockPath, guard) => {
    let working = loadPackLock(loreRoot);
    const installed: InstalledPack[] = [];
    for (const verified of verifiedPacks) {
      const name = verified.store.manifest.name;
      const dependencies = resolveDependencies(verified.store, working);
      const signature = resolveSignatureTrust(
        verified.signature,
        options.trustedKeyIds ?? [],
      );
      const existing = working.packages[name];
      if (
        existing &&
        existing.version === verified.store.manifest.version &&
        existing.integrity !== verified.integrity
      ) {
        throw new Error(
          `Pack ${name}@${existing.version} is immutable and already locked with different content`,
        );
      }
      const cachePath = cachePack(loreRoot, verified);
      const entry: PackLockEntry = {
        version: verified.store.manifest.version,
        integrity: verified.integrity,
        cache_digest: verified.digestHex,
        source: { type: "airgap" },
        signature,
        dependencies,
      };
      working = PackLockSchema.parse({
        lockfile_version: 1,
        roots: working.roots,
        packages: { ...working.packages, [name]: entry },
      });
      installed.push({
        name,
        version: entry.version,
        integrity: entry.integrity,
        lockPath,
        cachePath,
        created: !existing,
        updated:
          existing !== undefined &&
          JSON.stringify(existing) !== JSON.stringify(entry),
      });
    }
    working = PackLockSchema.parse({
      ...working,
      roots: [...new Set([...working.roots, validRootName])].sort(),
    });
    validateDependencyGraph(working);
    writePackLockUnderGuard(lockPath, working, guard);
    return installed;
  });
}

export function verifyAirgapPackBundle(
  packRoots: readonly string[],
  rootName: string,
): VerifiedPack[] {
  const validRootName = PackNameSchema.parse(rootName);
  const packs = new Map<string, VerifiedPack>();
  for (const packRoot of packRoots) {
    const verified = verifyPack(packRoot, { visibility: "either" });
    const name = verified.store.manifest.name;
    if (packs.has(name)) {
      throw new Error(`Air-gap bundle contains duplicate Pack: ${name}`);
    }
    packs.set(name, verified);
  }
  if (!packs.has(validRootName)) {
    throw new Error(`Air-gap bundle root is missing: ${validRootName}`);
  }
  const order = airgapBundleInstallOrder(validRootName, packs);
  if (order.length !== packs.size) {
    throw new Error("Air-gap bundle contains Packs outside the root dependency closure");
  }
  return order.map((name) => packs.get(name)!);
}

function installVerifiedPack(
  verified: VerifiedPack,
  loreRoot: string,
  source: PackLockEntry["source"],
  trustedKeyIds: string[],
): InstalledPack {
  return withPackLockMutation(loreRoot, (lockPath, guard) => {
    const lock = loadPackLock(loreRoot);
    const resolvedDependencies = resolveDependencies(verified.store, lock);
    const signature = resolveSignatureTrust(verified.signature, trustedKeyIds);
    const existing = lock.packages[verified.store.manifest.name];
    if (
      existing &&
      existing.version === verified.store.manifest.version &&
      existing.integrity !== verified.integrity
    ) {
      throw new Error(
        `Pack ${verified.store.manifest.name}@${existing.version} is immutable and already locked with different content`,
      );
    }

    const cachePath = cachePack(loreRoot, verified);
    const entry: PackLockEntry = {
      version: verified.store.manifest.version,
      integrity: verified.integrity,
      cache_digest: verified.digestHex,
      source,
      signature,
      dependencies: resolvedDependencies,
    };
    const next = PackLockSchema.parse({
      lockfile_version: 1,
      roots: [...new Set([...lock.roots, verified.store.manifest.name])].sort(),
      packages: {
        ...lock.packages,
        [verified.store.manifest.name]: entry,
      },
    });
    validateDependencyGraph(next);
    writePackLockUnderGuard(lockPath, next, guard);
    return {
      name: verified.store.manifest.name,
      version: verified.store.manifest.version,
      integrity: verified.integrity,
      lockPath,
      cachePath,
      created: !existing,
      updated:
        existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry),
    };
  });
}

export function loadPackLock(loreRoot = resolveLoreRoot()): PackLock {
  const lockPath = resolvePackLockPath(loreRoot);
  if (!fs.existsSync(lockPath)) {
    return { lockfile_version: 1, roots: [], packages: {} };
  }
  const entry = fs.lstatSync(lockPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Pack lockfile must be a regular file: ${lockPath}`);
  }
  return PackLockSchema.parse(
    yaml.load(readRegularFileNoFollow(lockPath, entry).toString("utf8")),
  );
}

export function loadEffectiveStore(
  loreRoot = resolveLoreRoot(),
): LoreStore {
  const local = loadStore(loreRoot);
  const lock = loadPackLock(loreRoot);
  validateDependencyGraph(lock);
  const lessons = [...local.lessons];
  const seen = new Map(lessons.map((lesson) => [lesson.id, "local"]));
  const loadErrors = [...local.loadErrors];

  for (const name of Object.keys(lock.packages).sort()) {
    const entry = lock.packages[name]!;
    const cachePath = packCachePath(loreRoot, entry.cache_digest);
    const verified = verifyPack(cachePath, {
      visibility:
        entry.source.type === "registry" || entry.source.type === "airgap"
          ? "either"
          : "public",
    });
    if (
      verified.integrity !== entry.integrity ||
      verified.digestHex !== entry.cache_digest ||
      verified.store.manifest.name !== name ||
      verified.store.manifest.version !== entry.version
    ) {
      throw new Error(`Installed Pack failed lock verification: ${name}`);
    }
    if (!signatureMatchesLock(verified.signature, entry.signature)) {
      throw new Error(`Installed Pack signature no longer matches the lock: ${name}`);
    }
    for (const lesson of verified.store.lessons) {
      const previous = seen.get(lesson.id);
      if (previous) {
        throw new Error(
          `Duplicate Lesson id ${lesson.id} from Pack ${name}; already provided by ${previous}`,
        );
      }
      seen.set(lesson.id, name);
      lessons.push(lesson);
    }
  }
  return { ...local, lessons, loadErrors };
}

export function verifyInstalledPacks(loreRoot = resolveLoreRoot()): PackLock {
  loadEffectiveStore(loreRoot);
  return loadPackLock(loreRoot);
}

export function signPack(packRoot: string, privateKeyPath: string): VerifiedPack {
  const before = verifyPack(packRoot, { visibility: "either" });
  const keyEntry = fs.lstatSync(privateKeyPath);
  if (keyEntry.isSymbolicLink() || !keyEntry.isFile()) {
    throw new Error(`Signing key must be a regular file: ${privateKeyPath}`);
  }
  const privateKey = createPrivateKey(
    readRegularFileNoFollow(privateKeyPath, keyEntry),
  );
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Pack signing requires an Ed25519 private key");
  }
  const publicDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const keyId = `sha256-${createHash("sha256").update(publicDer).digest("hex")}`;
  const signature = signBytes(
    null,
    Buffer.from(before.integrity, "utf8"),
    privateKey,
  );
  const document = PackSignatureFileSchema.parse({
    version: "0.1.0",
    algorithm: "ed25519",
    key_id: keyId,
    public_key_spki: publicDer.toString("base64"),
    integrity: before.integrity,
    signature: signature.toString("base64"),
  });
  const target = path.join(path.resolve(packRoot), PACK_SIGNATURE_FILE);
  const existing = fs.existsSync(target) ? fs.lstatSync(target) : undefined;
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Pack signature target must be a regular file: ${target}`);
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  fs.renameSync(temporary, target);
  return verifyPack(packRoot, { visibility: "either" });
}

function verifyPackSignature(
  root: string,
  integrity: string,
  files: string[],
): PackSignatureStatus {
  if (!files.includes(PACK_SIGNATURE_FILE)) return { status: "unverified" };
  const signaturePath = path.join(root, PACK_SIGNATURE_FILE);
  const entry = fs.lstatSync(signaturePath);
  const document = PackSignatureFileSchema.parse(
    JSON.parse(readRegularFileNoFollow(signaturePath, entry).toString("utf8")),
  );
  if (document.integrity !== integrity) {
    throw new Error("Pack signature integrity does not match the payload");
  }
  const publicDer = Buffer.from(document.public_key_spki, "base64");
  const keyId = `sha256-${createHash("sha256").update(publicDer).digest("hex")}`;
  if (document.key_id !== keyId) {
    throw new Error("Pack signature key id does not match its public key");
  }
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Pack signature public key is not Ed25519");
  }
  const valid = verifyBytes(
    null,
    Buffer.from(integrity, "utf8"),
    publicKey,
    Buffer.from(document.signature, "base64"),
  );
  if (!valid) throw new Error("Pack signature verification failed");
  return {
    status: "verified",
    algorithm: "ed25519",
    key_id: keyId,
    identity_trust: "self-asserted",
  };
}

function resolveSignatureTrust(
  signature: PackSignatureStatus,
  trustedKeyIds: string[],
): PackSignatureStatus {
  for (const keyId of trustedKeyIds) {
    if (!KEY_ID.test(keyId)) throw new Error(`Invalid trusted Pack key id: ${keyId}`);
  }
  if (trustedKeyIds.length === 0) return signature;
  if (
    signature.status !== "verified" ||
    !trustedKeyIds.includes(signature.key_id)
  ) {
    throw new Error("Pack signature does not match an explicitly trusted key id");
  }
  return { ...signature, identity_trust: "explicit-key" };
}

function signatureMatchesLock(
  actual: PackSignatureStatus,
  locked: PackSignatureStatus,
): boolean {
  if (actual.status !== locked.status) return false;
  if (actual.status === "unverified" || locked.status === "unverified") return true;
  return actual.algorithm === locked.algorithm && actual.key_id === locked.key_id;
}

function allowedPackFiles(lessons: Lesson[]): Set<string> {
  const files = new Set<string>(["manifest.yaml", PACK_SIGNATURE_FILE]);
  for (const doc of ["README.md", "CHANGELOG.md", "LICENSE"]) {
    files.add(doc);
  }
  for (const lesson of lessons) {
    files.add(`lessons/${lesson.id}.yaml`);
    for (const fixture of [
      ...lesson.enforcement.fixtures.bad,
      ...lesson.enforcement.fixtures.good,
    ]) {
      files.add(normalizeRelativePackPath(fixture));
    }
  }
  return files;
}

function enumeratePackFiles(root: string): string[] {
  const files: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (directory === root && name === ".git") continue;
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) {
        throw new Error(`Pack must not contain symbolic links: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Pack contains a non-regular file: ${relative}`);
      }
      if (entry.size > MAX_PACK_FILE_BYTES) {
        throw new Error(`Pack file exceeds ${MAX_PACK_FILE_BYTES} bytes: ${relative}`);
      }
      totalBytes += entry.size;
      files.push(relative);
      if (files.length > MAX_PACK_FILES || totalBytes > MAX_PACK_BYTES) {
        throw new Error("Pack exceeds file-count or total-size limits");
      }
    }
  };
  visit(root);
  return files.sort();
}

function hashPackFiles(
  root: string,
  files: string[],
): { hex: string; base64: string } {
  const hash = createHash("sha256");
  for (const relative of [...files].sort()) {
    const absolute = path.join(root, ...relative.split("/"));
    const entry = fs.lstatSync(absolute);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Pack file changed during hashing: ${relative}`);
    }
    const body = readRegularFileNoFollow(absolute, entry);
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(String(body.length), "utf8");
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  const digest = hash.digest();
  return { hex: digest.toString("hex"), base64: digest.toString("base64") };
}

function normalizeRelativePackPath(value: string): string {
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    value.split("/").includes("")
  ) {
    throw new Error(`Pack path must be a portable relative POSIX path: ${value}`);
  }
  return value;
}

function normalizePackSubdirectory(value: string): string {
  const normalized = normalizeRelativePackPath(value);
  if (
    normalized.length > 256 ||
    normalized === "." ||
    normalized
      .split("/")
      .some((segment) => segment === "." || segment === ".git")
  ) {
    throw new Error(`Invalid Pack repository subdirectory: ${value}`);
  }
  return normalized;
}

function selectPackRoot(baseRoot: string, subdir?: string): string {
  if (!subdir) return baseRoot;
  const normalized = normalizePackSubdirectory(subdir);
  let selected = baseRoot;
  for (const segment of normalized.split("/")) {
    selected = path.join(selected, segment);
    if (!fs.existsSync(selected)) {
      throw new Error(`Pack repository subdirectory does not exist: ${normalized}`);
    }
    const entry = fs.lstatSync(selected);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `Pack repository subdirectory must contain only real directories: ${normalized}`,
      );
    }
  }
  const realBase = fs.realpathSync.native(baseRoot);
  const realSelected = fs.realpathSync.native(selected);
  const relative = path.relative(realBase, realSelected);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Pack repository subdirectory escapes its source: ${normalized}`);
  }
  return realSelected;
}

function assertPublicPackPayloadSafe(root: string, files: string[]): void {
  if (!files.includes("LICENSE")) {
    throw new Error("Public Pack must include a LICENSE file");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split("/"));
    const entry = fs.lstatSync(absolute);
    let content: string;
    try {
      content = decoder.decode(readRegularFileNoFollow(absolute, entry));
    } catch (error) {
      throw new Error(`Public Pack payload must be UTF-8 text: ${relative}`, {
        cause: error,
      });
    }
    if (relative === "LICENSE" && content.trim().length === 0) {
      throw new Error("Public Pack LICENSE must contain non-empty UTF-8 text");
    }
    const issues = findSensitiveInputIssues(content).filter((issue) => {
      if (issue.includes("unusually large")) return false;
      if (relative === "LICENSE" && issue.includes("email address or PII")) {
        return false;
      }
      return true;
    });
    if (issues.length > 0) {
      throw new Error(
        `Unsafe public Pack payload ${relative}: ${issues.join("; ")}`,
      );
    }
  }
}

function resolveDependencies(
  store: LoreStore,
  lock: PackLock,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, range] of Object.entries(store.manifest.dependencies)) {
    const dependency = lock.packages[name];
    if (
      !dependency ||
      !semver.satisfies(dependency.version, range, { includePrerelease: true })
    ) {
      throw new Error(
        `Pack dependency is not installed at a compatible version: ${name}@${range}`,
      );
    }
    resolved[name] = dependency.version;
  }
  return resolved;
}

function validateDependencyGraph(lock: PackLock): void {
  for (const root of lock.roots) {
    if (!lock.packages[root]) throw new Error(`Pack lock root is missing: ${root}`);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new Error(`Pack dependency cycle detected at ${name}`);
    if (visited.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Pack lock dependency is missing: ${name}`);
    active.add(name);
    for (const [dependencyName, version] of Object.entries(entry.dependencies)) {
      const dependency = lock.packages[dependencyName];
      if (!dependency || dependency.version !== version) {
        throw new Error(
          `Pack lock dependency mismatch: ${name} requires ${dependencyName}@${version}`,
        );
      }
      visit(dependencyName);
    }
    active.delete(name);
    visited.add(name);
  };
  for (const root of lock.roots) visit(root);
  for (const name of Object.keys(lock.packages)) {
    if (!visited.has(name)) throw new Error(`Pack lock contains unreachable package: ${name}`);
  }
}

export function resolvePackCachePath(
  loreRoot: string,
  digestHex: string,
): string {
  return path.join(path.resolve(loreRoot), "packs", "sha256", digestHex);
}

const packCachePath = resolvePackCachePath;

function airgapBundleInstallOrder(
  rootName: string,
  packs: ReadonlyMap<string, VerifiedPack>,
): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const order: string[] = [];
  const visit = (name: string): void => {
    if (active.has(name)) {
      throw new Error(`Air-gap bundle dependency cycle detected at ${name}`);
    }
    if (visited.has(name)) return;
    const pack = packs.get(name);
    if (!pack) throw new Error(`Air-gap bundle dependency is missing: ${name}`);
    active.add(name);
    for (const [dependencyName, range] of Object.entries(
      pack.store.manifest.dependencies,
    )) {
      const dependency = packs.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `Air-gap bundle is missing dependency ${dependencyName} required by ${name}`,
        );
      }
      if (!semver.satisfies(dependency.store.manifest.version, range)) {
        throw new Error(
          `Air-gap bundle dependency mismatch: ${name} requires ${dependencyName}@${range}`,
        );
      }
      visit(dependencyName);
    }
    active.delete(name);
    visited.add(name);
    order.push(name);
  };
  visit(rootName);
  return order;
}

function cachePack(loreRoot: string, pack: VerifiedPack): string {
  const parent = path.join(path.resolve(loreRoot), "packs", "sha256");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  ensureRealDirectory(parent, "Pack cache");
  const destination = packCachePath(loreRoot, pack.digestHex);
  if (fs.existsSync(destination)) {
    const existing = verifyPack(destination, {
      visibility: pack.store.manifest.visibility,
    });
    if (
      existing.integrity !== pack.integrity ||
      existing.digestHex !== pack.digestHex
    ) {
      throw new Error(`Existing Pack cache failed integrity verification: ${destination}`);
    }
    return destination;
  }
  const temporary = path.join(parent, `.tmp-${randomUUID()}`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const relative of pack.files) {
      const source = path.join(pack.root, ...relative.split("/"));
      const target = path.join(temporary, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, readRegularFileNoFollow(source, fs.lstatSync(source)), {
        flag: "wx",
        mode: 0o400,
      });
      try {
        fs.chmodSync(target, 0o400);
      } catch {
        // Windows ACLs do not map cleanly to POSIX modes.
      }
    }
    if (
      verifyPack(temporary, { visibility: pack.store.manifest.visibility })
        .integrity !== pack.integrity
    ) {
      throw new Error("Pack changed while being copied into the cache");
    }
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  return destination;
}

interface PackLockMutationGuard {
  path: string;
  descriptor: number;
  identity: { dev: number; ino: number };
}

function withPackLockMutation<T>(
  loreRoot: string,
  mutation: (lockPath: string, guard: PackLockMutationGuard) => T,
): T {
  const lockPath = resolvePackLockPath(loreRoot);
  const guard = acquirePackLockMutationGuard(lockPath);
  try {
    return mutation(lockPath, guard);
  } finally {
    releasePackLockMutationGuard(guard);
  }
}

function acquirePackLockMutationGuard(lockPath: string): PackLockMutationGuard {
  const guardPath = `${lockPath}.lock`;
  const timeoutMs = resolvePackLockWaitTimeout();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const descriptor = fs.openSync(guardPath, "wx", 0o600);
      const entry = fs.fstatSync(descriptor);
      return {
        path: guardPath,
        descriptor,
        identity: { dev: entry.dev, ino: entry.ino },
      };
    } catch (error) {
      // EEXIST is the normal contention signal. Windows can also surface a
      // competitor's guard as EPERM or EBUSY while the file sits in the
      // delete-pending state between the holder's close and unlink, so those
      // are contention too; they stay bounded by the same deadline, which
      // converts a genuine permission fault into a clear timeout instead of
      // an immediate crash mid-install.
      if (
        !isFileSystemError(error, "EEXIST") &&
        !isFileSystemError(error, "EPERM") &&
        !isFileSystemError(error, "EBUSY")
      ) {
        throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for Pack lockfile mutation guard: ${guardPath}`,
        );
      }
      Atomics.wait(
        PACK_LOCK_WAIT_BUFFER,
        0,
        0,
        Math.min(PACK_LOCK_RETRY_MS, remainingMs),
      );
    }
  }
}

function resolvePackLockWaitTimeout(): number {
  const configured = process.env.PITLORE_PACK_LOCK_TIMEOUT_MS;
  if (configured === undefined) return PACK_LOCK_WAIT_TIMEOUT_MS;
  if (!/^\d{1,6}$/u.test(configured)) {
    throw new Error("PITLORE_PACK_LOCK_TIMEOUT_MS must be an integer from 0 to 300000");
  }
  const timeoutMs = Number(configured);
  if (timeoutMs > 300_000) {
    throw new Error("PITLORE_PACK_LOCK_TIMEOUT_MS must be an integer from 0 to 300000");
  }
  return timeoutMs;
}

function assertPackLockMutationGuard(guard: PackLockMutationGuard): void {
  const descriptorEntry = fs.fstatSync(guard.descriptor);
  const pathEntry = fs.existsSync(guard.path) ? fs.lstatSync(guard.path) : undefined;
  if (
    !pathEntry?.isFile() ||
    pathEntry.isSymbolicLink() ||
    descriptorEntry.dev !== guard.identity.dev ||
    descriptorEntry.ino !== guard.identity.ino ||
    pathEntry.dev !== guard.identity.dev ||
    pathEntry.ino !== guard.identity.ino
  ) {
    throw new Error(`Pack lockfile mutation guard changed while held: ${guard.path}`);
  }
}

function releasePackLockMutationGuard(guard: PackLockMutationGuard): void {
  fs.closeSync(guard.descriptor);
  const entry = fs.existsSync(guard.path) ? fs.lstatSync(guard.path) : undefined;
  if (
    entry?.isFile() &&
    !entry.isSymbolicLink() &&
    entry.dev === guard.identity.dev &&
    entry.ino === guard.identity.ino
  ) {
    fs.unlinkSync(guard.path);
  }
}

function writePackLockUnderGuard(
  lockPath: string,
  lock: PackLock,
  guard: PackLockMutationGuard,
): void {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  try {
    assertPackLockMutationGuard(guard);
    const existing = fs.existsSync(lockPath) ? fs.lstatSync(lockPath) : undefined;
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error(`Pack lockfile target must be a regular file: ${lockPath}`);
    }
    const body = yaml.dump(lock, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: true,
    });
    const fd = fs.openSync(temporary, "wx", 0o644);
    try {
      const temporaryEntry = fs.fstatSync(fd);
      temporaryIdentity = { dev: temporaryEntry.dev, ino: temporaryEntry.ino };
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertPackLockMutationGuard(guard);
    fs.renameSync(temporary, lockPath);
  } finally {
    const temporaryEntry = fs.existsSync(temporary)
      ? fs.lstatSync(temporary)
      : undefined;
    if (
      temporaryEntry &&
      temporaryIdentity &&
      temporaryEntry.dev === temporaryIdentity.dev &&
      temporaryEntry.ino === temporaryIdentity.ino
    ) {
      fs.unlinkSync(temporary);
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function readRegularFileNoFollow(filePath: string, expected: fs.Stats): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const current = fs.fstatSync(descriptor);
    if (
      !current.isFile() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`Pack file changed during read: ${filePath}`);
    }
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ELOOP", "EMLINK"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw new Error(`Pack file must not be a symbolic link: ${filePath}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureRealDirectory(directory: string, label: string): void {
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function acquirePackSource(
  source: string,
  projectRoot: string,
  ref?: string,
  subdir?: string,
): {
  root: string;
  provenance: (integrity: string) => PackLockEntry["source"];
  cleanup: () => void;
} {
  if (fs.existsSync(source)) {
    if (ref) throw new Error("--ref is only valid for Git sources");
    const entry = fs.lstatSync(source);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Local Pack source must be a real directory: ${source}`);
    }
    const sourceRoot = fs.realpathSync.native(source);
    const root = selectPackRoot(sourceRoot, subdir);
    const canonicalProjectRoot = fs.realpathSync.native(projectRoot);
    const relative = path
      .relative(canonicalProjectRoot, root)
      .split(path.sep)
      .join("/");
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(
        "Local Pack sources must be inside the project so the lockfile does not leak machine-specific paths",
      );
    }
    const lockedPath = relative || ".";
    return {
      root,
      provenance: (integrity) => ({ type: "local", path: lockedPath, tree: integrity }),
      cleanup: () => {},
    };
  }

  const url = validateGitUrl(source);
  const normalizedSubdir = subdir
    ? normalizePackSubdirectory(subdir)
    : null;
  if (ref && (ref.startsWith("-") || ref.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(ref))) {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
  const timeout = resolvePackGitTimeout();
  const transferCap = resolvePackGitTransferCap();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-pack-"));
  const clone = path.join(temporary, "repo");
  const isolatedGitConfig = path.join(temporary, "gitconfig");
  const args = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.lowSpeedLimit=1024",
    "-c",
    "http.lowSpeedTime=30",
    "clone",
    "--depth",
    "1",
    "--no-tags",
    "--no-recurse-submodules",
  ];
  if (ref) args.push("--branch", ref);
  args.push("--", url, clone);
  try {
    fs.writeFileSync(isolatedGitConfig, "", { encoding: "utf8", mode: 0o600 });
    runProcessWithDiskTransferCap(temporary, transferCap, timeout, "git", args, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: isolatedGitConfig,
      GIT_LFS_SKIP_SMUDGE: "1",
    });
    const commit = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: PACK_GIT_MAX_OUTPUT_BYTES,
    }).trim().toLowerCase();
    if (!GIT_COMMIT.test(commit)) throw new Error("Git source returned an invalid commit id");
    return {
      root: selectPackRoot(clone, normalizedSubdir ?? undefined),
      provenance: () => ({
        type: "git",
        url,
        ref: ref ?? null,
        commit,
        subdir: normalizedSubdir,
      }),
      cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (isGitTimeoutError(error)) {
      throw new Error(`Git Pack source timed out after ${timeout}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

function resolvePackGitTimeout(): number {
  const configured = process.env.PITLORE_PACK_GIT_TIMEOUT_MS;
  if (configured === undefined || configured.trim() === "") {
    return PACK_GIT_TIMEOUT_MS;
  }
  const timeout = Number(configured);
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 300_000) {
    throw new Error(
      "PITLORE_PACK_GIT_TIMEOUT_MS must be an integer between 250 and 300000",
    );
  }
  return timeout;
}

function resolvePackGitTransferCap(): number {
  const configured = process.env.PITLORE_PACK_GIT_MAX_TRANSFER_BYTES;
  if (configured === undefined || configured.trim() === "") {
    return PACK_GIT_MAX_TRANSFER_BYTES;
  }
  const cap = Number(configured);
  if (!Number.isInteger(cap) || cap < 65_536 || cap > 1_073_741_824) {
    throw new Error(
      "PITLORE_PACK_GIT_MAX_TRANSFER_BYTES must be an integer between 65536 and 1073741824",
    );
  }
  return cap;
}

export function runProcessWithDiskTransferCap(
  watchDir: string,
  capBytes: number,
  timeoutMs: number,
  command: string,
  commandArgs: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        PACK_GIT_WATCHDOG_SOURCE,
        "--",
        PACK_GIT_WATCHDOG_MARKER,
        watchDir,
        String(capBytes),
        String(timeoutMs),
        String(PACK_GIT_TRANSFER_POLL_MS),
        command,
        ...commandArgs,
      ],
      {
        stdio: "pipe",
        // The watchdog enforces the real deadline; this outer timeout is only a
        // backstop against a wedged watchdog process itself.
        timeout: timeoutMs + 5_000,
        maxBuffer: PACK_GIT_MAX_OUTPUT_BYTES,
        env: { ...process.env, ...extraEnv },
      },
    );
  } catch (error) {
    const status =
      error && typeof error === "object"
        ? (error as { status?: number | null }).status
        : undefined;
    if (status === PACK_GIT_TRANSFER_CAP_EXIT) {
      throw new Error(
        `Git Pack source exceeded the ${capBytes}-byte transfer cap`,
        { cause: error },
      );
    }
    if (status === PACK_GIT_WATCHDOG_TIMEOUT_EXIT) {
      throw new Error(`Git Pack source timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

function isGitTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as NodeJS.ErrnoException & {
    signal?: NodeJS.Signals | null;
    status?: number | null;
  };
  return (
    value.code === "ETIMEDOUT" ||
    (value.status === null && typeof value.signal === "string")
  );
}

function validateGitUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Pack source must be an existing local directory or an HTTPS Git URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new Error("Git Pack source must be credential-free HTTPS without query or fragment");
  }
  return parsed.toString();
}

function validateRegistryUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Registry source must be an absolute HTTPS URL");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new Error(
      "Registry source must use credential-free HTTPS (or loopback HTTP) without query or fragment",
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/`;
  return parsed.toString();
}
