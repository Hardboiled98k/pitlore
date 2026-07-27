import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  throw new Error(`release artifact verification failed: ${message}`);
}

function resolveArchive(input) {
  const supplied = path.resolve(projectRoot, input);
  const stat = fs.statSync(supplied);
  if (stat.isFile()) {
    if (!supplied.endsWith(".tgz")) fail("artifact file must end in .tgz");
    return supplied;
  }
  if (!stat.isDirectory()) fail("artifact input must be a file or directory");

  const archives = fs
    .readdirSync(supplied)
    .filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    fail("artifact directory must contain exactly one .tgz file");
  }
  return path.join(supplied, archives[0]);
}

function readTarString(header, start, end) {
  return header
    .subarray(start, end)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function readTarSize(header) {
  const raw = readTarString(header, 124, 136).trim();
  if (raw && !/^[0-7]+$/u.test(raw)) {
    fail("archive contains an unsupported tar size field");
  }
  const size = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    fail("archive contains an invalid tar entry size");
  }
  return size;
}

function readPackagedManifest(archive) {
  let tar;
  try {
    tar = zlib.gunzipSync(fs.readFileSync(archive), {
      maxOutputLength: 10_000_000,
    });
  } catch (error) {
    throw new Error(
      "release artifact verification failed: archive is invalid or expands beyond 10 MB",
      { cause: error },
    );
  }

  let manifestText;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 500);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = readTarSize(header);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) fail("archive contains a truncated tar entry");

    if (entryPath === "package/package.json") {
      if (manifestText !== undefined) {
        fail("archive contains more than one package/package.json");
      }
      manifestText = tar.subarray(contentStart, contentEnd).toString("utf8");
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  if (manifestText === undefined) {
    fail("archive does not contain package/package.json");
  }
  try {
    return JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      "release artifact verification failed: packaged manifest is invalid JSON",
      { cause: error },
    );
  }
}

const [artifactArgument, tagArgument, versionArgument, sha256Argument] =
  process.argv.slice(2);
const artifactInput =
  artifactArgument ?? process.env.PITLORE_RELEASE_ARTIFACT;
const expectedTag = tagArgument ?? process.env.PITLORE_RELEASE_TAG;
const expectedVersion =
  versionArgument ?? process.env.PITLORE_RELEASE_VERSION;
const expectedSha256 =
  sha256Argument ?? process.env.PITLORE_RELEASE_SHA256;
const requireSha256 = process.env.PITLORE_REQUIRE_SHA256 === "true";
if (!artifactInput || !expectedTag || !expectedVersion) {
  fail(
    "usage: node scripts/verify-release-artifact.mjs <tgz-or-directory> <vX.Y.Z-tag> <X.Y.Z-version>",
  );
}

const archive = resolveArchive(artifactInput);
const sourceManifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const packagedManifest = readPackagedManifest(archive);

if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
  fail("expected version is not a release SemVer");
}
if (expectedTag !== `v${expectedVersion}`) {
  fail(`tag ${expectedTag} does not equal v${expectedVersion}`);
}
if (
  sourceManifest.name !== "pitlore" ||
  sourceManifest.version !== expectedVersion
) {
  fail("source package name/version does not match the requested release");
}
if (
  packagedManifest.name !== sourceManifest.name ||
  packagedManifest.version !== sourceManifest.version ||
  packagedManifest.repository?.url !== sourceManifest.repository?.url
) {
  fail("packaged manifest does not match the checked-out source manifest");
}

const expectedArchiveName = `pitlore-${expectedVersion}.tgz`;
if (path.basename(archive) !== expectedArchiveName) {
  fail(`archive name does not equal ${expectedArchiveName}`);
}

const sha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(archive))
  .digest("hex");
if (requireSha256 && !expectedSha256) {
  fail("an expected SHA-256 is required for this verification stage");
}
if (
  expectedSha256 &&
  (!/^[0-9a-f]{64}$/u.test(expectedSha256) || sha256 !== expectedSha256)
) {
  fail("archive SHA-256 does not match the build job output");
}
const output = {
  archive,
  name: packagedManifest.name,
  sha256,
  tag: expectedTag,
  version: expectedVersion,
};

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `archive=${archive}\nsha256=${sha256}\nversion=${expectedVersion}\n`,
  );
}
console.log(JSON.stringify(output));
