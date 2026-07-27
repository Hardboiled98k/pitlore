import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  installAirgapPackBundle,
  resolvePackCachePath,
  verifyAirgapPackBundle,
  verifyInstalledPacks,
  verifyPack,
  type InstallAirgapPackBundleOptions,
  type InstalledPack,
  type VerifiedPack,
} from "./pack.js";
import { PackNameSchema, SemverSchema } from "./schema.js";

const MAX_ARTIFACT_FILES = 1_000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SERIALIZED_BYTES = 30 * 1024 * 1024;
const MAX_BUNDLE_PACKS = 64;
const MAX_BUNDLE_DECODED_BYTES = 80 * 1024 * 1024;
const MAX_BUNDLE_SERIALIZED_BYTES = 120 * 1024 * 1024;
const SHA256_INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const RegistryArtifactFileSchema = z
  .object({
    path: z.string().min(1).max(512),
    size: z.number().int().min(0).max(MAX_ARTIFACT_FILE_BYTES),
    sha256: z.string().regex(SHA256_INTEGRITY),
    content_base64: z.string().max(Math.ceil(MAX_ARTIFACT_FILE_BYTES / 3) * 4 + 4),
  })
  .strict()
  .superRefine((file, context) => {
    try {
      assertPortableArtifactPath(file.path);
      const content = decodeCanonicalBase64(file.content_base64);
      if (content.length !== file.size) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["size"],
          message: "artifact file size does not match its content",
        });
      }
      if (sha256Integrity(content) !== file.sha256) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sha256"],
          message: "artifact file checksum does not match its content",
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const RegistryPackArtifactSchema = z
  .object({
    format: z.literal("pitlore.pack.artifact.v1"),
    name: PackNameSchema,
    version: SemverSchema,
    integrity: z.string().regex(SHA256_INTEGRITY),
    digest_hex: z.string().regex(SHA256_HEX),
    files: z.array(RegistryArtifactFileSchema).min(1).max(MAX_ARTIFACT_FILES),
  })
  .strict()
  .superRefine((artifact, context) => {
    const paths = artifact.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "artifact file paths must be unique",
      });
    }
    const sorted = [...paths].sort((left, right) => left.localeCompare(right));
    if (paths.some((filePath, index) => filePath !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "artifact files must use canonical path order",
      });
    }
    const total = artifact.files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ARTIFACT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: `artifact exceeds ${MAX_ARTIFACT_BYTES} decoded bytes`,
      });
    }
  });

export type RegistryPackArtifact = z.infer<typeof RegistryPackArtifactSchema>;

export const RegistryPackBundleSchema = z
  .object({
    format: z.literal("pitlore.pack.bundle.v1"),
    root: PackNameSchema,
    artifacts: z
      .array(RegistryPackArtifactSchema)
      .min(1)
      .max(MAX_BUNDLE_PACKS),
  })
  .strict()
  .superRefine((bundle, context) => {
    const names = bundle.artifacts.map((artifact) => artifact.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "bundle Pack names must be unique",
      });
    }
    const sorted = [...names].sort((left, right) => left.localeCompare(right));
    if (names.some((name, index) => name !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "bundle Packs must use canonical name order",
      });
    }
    if (!names.includes(bundle.root)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["root"],
        message: "bundle root Pack is missing",
      });
    }
    const decodedBytes = bundle.artifacts.reduce(
      (sum, artifact) =>
        sum + artifact.files.reduce((fileSum, file) => fileSum + file.size, 0),
      0,
    );
    if (decodedBytes > MAX_BUNDLE_DECODED_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: `bundle exceeds ${MAX_BUNDLE_DECODED_BYTES} decoded bytes`,
      });
    }
  });

export type RegistryPackBundle = z.infer<typeof RegistryPackBundleSchema>;

export interface RegistryArtifactStore {
  assertCompatible(orgId: string, artifact: RegistryPackArtifact): void;
  put(orgId: string, artifact: RegistryPackArtifact): void;
  get(
    orgId: string,
    packageName: string,
    version: string,
  ): RegistryPackArtifact | undefined;
}

export class RegistryArtifactConflictError extends Error {
  constructor(message = "Registry artifact conflicts with an immutable release") {
    super(message);
    this.name = "RegistryArtifactConflictError";
  }
}

/** Bounded in-memory artifact storage for tests and single-process self-hosting. */
export class InMemoryRegistryArtifactStore implements RegistryArtifactStore {
  readonly #artifacts = new Map<string, string>();

  assertCompatible(orgId: string, input: RegistryPackArtifact): void {
    const artifact = RegistryPackArtifactSchema.parse(input);
    const key = artifactKey(orgId, artifact.name, artifact.version);
    const existing = this.#artifacts.get(key);
    if (existing && existing !== serializeRegistryPackArtifact(artifact)) {
      throw new RegistryArtifactConflictError(
        `Registry artifact is immutable and already exists: ${artifact.name}@${artifact.version}`,
      );
    }
  }

  put(orgId: string, input: RegistryPackArtifact): void {
    const artifact = RegistryPackArtifactSchema.parse(input);
    this.assertCompatible(orgId, artifact);
    this.#artifacts.set(
      artifactKey(orgId, artifact.name, artifact.version),
      serializeRegistryPackArtifact(artifact),
    );
  }

  get(
    orgId: string,
    packageName: string,
    version: string,
  ): RegistryPackArtifact | undefined {
    const serialized = this.#artifacts.get(artifactKey(orgId, packageName, version));
    return serialized ? parseRegistryPackArtifact(serialized) : undefined;
  }
}

export function createRegistryPackArtifact(packRoot: string): RegistryPackArtifact {
  const verified = verifyPack(packRoot, { visibility: "either" });
  const files = [...verified.files]
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => {
      assertPortableArtifactPath(relative);
      const absolute = path.join(verified.root, ...relative.split("/"));
      const content = readRegularFileNoFollow(absolute);
      return {
        path: relative,
        size: content.length,
        sha256: sha256Integrity(content),
        content_base64: content.toString("base64"),
      };
    });
  return RegistryPackArtifactSchema.parse({
    format: "pitlore.pack.artifact.v1",
    name: verified.store.manifest.name,
    version: verified.store.manifest.version,
    integrity: verified.integrity,
    digest_hex: verified.digestHex,
    files,
  });
}

export function createRegistryPackBundle(
  loreRoot: string,
  rootName: string,
): RegistryPackBundle {
  const root = path.resolve(loreRoot);
  const lock = verifyInstalledPacks(root);
  const validRoot = PackNameSchema.parse(rootName);
  if (!lock.packages[validRoot]) {
    throw new Error(`Pack is not installed: ${validRoot}`);
  }
  const closure = new Set<string>();
  const visit = (name: string): void => {
    if (closure.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Pack lock dependency is missing: ${name}`);
    closure.add(name);
    for (const dependencyName of Object.keys(entry.dependencies)) {
      visit(dependencyName);
    }
  };
  visit(validRoot);
  const artifacts = [...closure]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const entry = lock.packages[name]!;
      const artifact = createRegistryPackArtifact(
        resolvePackCachePath(root, entry.cache_digest),
      );
      if (
        artifact.name !== name ||
        artifact.version !== entry.version ||
        artifact.integrity !== entry.integrity ||
        artifact.digest_hex !== entry.cache_digest
      ) {
        throw new Error(`Installed Pack does not match its lock entry: ${name}`);
      }
      return artifact;
    });
  return RegistryPackBundleSchema.parse({
    format: "pitlore.pack.bundle.v1",
    root: validRoot,
    artifacts,
  });
}

export function parseRegistryPackArtifact(serialized: string): RegistryPackArtifact {
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new Error(`Registry Pack artifact exceeds ${MAX_SERIALIZED_BYTES} serialized bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Registry Pack artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return RegistryPackArtifactSchema.parse(parsed);
}

export function parseRegistryPackBundle(serialized: string): RegistryPackBundle {
  if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_SERIALIZED_BYTES) {
    throw new Error(
      `Registry Pack bundle exceeds ${MAX_BUNDLE_SERIALIZED_BYTES} serialized bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Registry Pack bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return RegistryPackBundleSchema.parse(parsed);
}

export function serializeRegistryPackArtifact(input: unknown): string {
  const artifact = RegistryPackArtifactSchema.parse(input);
  const serialized = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new Error(`Registry Pack artifact exceeds ${MAX_SERIALIZED_BYTES} serialized bytes`);
  }
  return serialized;
}

export function serializeRegistryPackBundle(input: unknown): string {
  const bundle = RegistryPackBundleSchema.parse(input);
  const serialized = `${JSON.stringify(bundle)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_SERIALIZED_BYTES) {
    throw new Error(
      `Registry Pack bundle exceeds ${MAX_BUNDLE_SERIALIZED_BYTES} serialized bytes`,
    );
  }
  return serialized;
}

export function readRegistryPackArtifactFile(
  filename: string,
): RegistryPackArtifact {
  const absolute = path.resolve(filename);
  const entry = fs.lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Registry Pack artifact must be a regular file: ${absolute}`);
  }
  return parseRegistryPackArtifact(
    readRegularFileNoFollow(absolute).toString("utf8"),
  );
}

export function readRegistryPackBundleFile(
  filename: string,
): RegistryPackBundle {
  const absolute = path.resolve(filename);
  const entry = fs.lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Registry Pack bundle must be a regular file: ${absolute}`);
  }
  return parseRegistryPackBundle(
    readRegularFileNoFollow(absolute).toString("utf8"),
  );
}

export function writeRegistryPackArtifactFile(
  filename: string,
  input: unknown,
): string {
  const absolute = path.resolve(filename);
  const parent = path.dirname(absolute);
  const parentEntry = fs.lstatSync(parent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new Error(`Registry Pack artifact parent must be a real directory: ${parent}`);
  }
  if (fs.existsSync(absolute)) {
    throw new Error(`Registry Pack artifact output already exists: ${absolute}`);
  }
  const serialized = serializeRegistryPackArtifact(input);
  let descriptor: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    descriptor = fs.openSync(absolute, "wx", 0o600);
    const entry = fs.fstatSync(descriptor);
    identity = { dev: entry.dev, ino: entry.ino };
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    return absolute;
  } catch (error) {
    const current = fs.existsSync(absolute) ? fs.lstatSync(absolute) : undefined;
    if (
      current &&
      identity &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      fs.unlinkSync(absolute);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeRegistryPackBundleFile(
  filename: string,
  input: unknown,
): string {
  return writeSerializedTransportFile(
    filename,
    serializeRegistryPackBundle(input),
    "Registry Pack bundle",
  );
}

export function materializeRegistryPackArtifact(
  input: unknown,
  destination: string,
): VerifiedPack {
  const artifact = RegistryPackArtifactSchema.parse(input);
  const target = path.resolve(destination);
  if (fs.existsSync(target)) {
    throw new Error(`Registry Pack artifact destination already exists: ${target}`);
  }
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  try {
    for (const file of artifact.files) {
      const absolute = path.join(target, ...file.path.split("/"));
      const relative = path.relative(target, absolute);
      if (
        relative === "" ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Registry Pack artifact path escapes destination: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      fs.writeFileSync(absolute, decodeCanonicalBase64(file.content_base64), {
        flag: "wx",
        mode: 0o400,
      });
    }
    const verified = verifyPack(target, { visibility: "either" });
    if (
      verified.store.manifest.name !== artifact.name ||
      verified.store.manifest.version !== artifact.version ||
      verified.integrity !== artifact.integrity ||
      verified.digestHex !== artifact.digest_hex
    ) {
      throw new Error("Registry Pack artifact metadata does not match verified Pack content");
    }
    return verified;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function withMaterializedRegistryPackArtifact<T>(
  input: unknown,
  operation: (verified: VerifiedPack) => T,
): T {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-registry-artifact-"));
  const destination = path.join(parent, "pack");
  try {
    return operation(materializeRegistryPackArtifact(input, destination));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

export function withMaterializedRegistryPackBundle<T>(
  input: unknown,
  operation: (bundle: RegistryPackBundle, packs: readonly VerifiedPack[]) => T,
): T {
  const bundle = RegistryPackBundleSchema.parse(input);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-pack-bundle-"));
  try {
    const roots = bundle.artifacts.map((artifact, index) => {
      const destination = path.join(parent, `pack-${index}`);
      materializeRegistryPackArtifact(artifact, destination);
      return destination;
    });
    const packs = verifyAirgapPackBundle(roots, bundle.root);
    return operation(bundle, packs);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

export function installRegistryPackBundle(
  input: unknown,
  options: InstallAirgapPackBundleOptions = {},
): InstalledPack[] {
  return withMaterializedRegistryPackBundle(input, (bundle, packs) =>
    installAirgapPackBundle(
      packs.map((pack) => pack.root),
      bundle.root,
      options,
    ),
  );
}

function writeSerializedTransportFile(
  filename: string,
  serialized: string,
  label: string,
): string {
  const absolute = path.resolve(filename);
  const parent = path.dirname(absolute);
  const parentEntry = fs.lstatSync(parent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new Error(`${label} parent must be a real directory: ${parent}`);
  }
  if (fs.existsSync(absolute)) {
    throw new Error(`${label} output already exists: ${absolute}`);
  }
  let descriptor: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    descriptor = fs.openSync(absolute, "wx", 0o600);
    const entry = fs.fstatSync(descriptor);
    identity = { dev: entry.dev, ino: entry.ino };
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    return absolute;
  } catch (error) {
    const current = fs.existsSync(absolute) ? fs.lstatSync(absolute) : undefined;
    if (
      current &&
      identity &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      fs.unlinkSync(absolute);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertPortableArtifactPath(value: string): void {
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Registry Pack artifact path must be portable and relative: ${value}`);
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("artifact file content must use canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("artifact file content must use canonical base64");
  }
  return decoded;
}

function sha256Integrity(content: Buffer): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

function readRegularFileNoFollow(filePath: string): Buffer {
  const expected = fs.lstatSync(filePath);
  if (expected.isSymbolicLink() || !expected.isFile()) {
    throw new Error(`Registry Pack artifact source must be a regular file: ${filePath}`);
  }
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
      throw new Error(`Registry Pack artifact source changed during read: ${filePath}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function artifactKey(orgId: string, packageName: string, version: string): string {
  if (
    typeof orgId !== "string" ||
    orgId.length === 0 ||
    orgId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(orgId)
  ) {
    throw new Error("Registry artifact organization id is invalid");
  }
  return JSON.stringify([
    orgId,
    PackNameSchema.parse(packageName),
    SemverSchema.parse(version),
  ]);
}
