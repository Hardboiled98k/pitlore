import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requestedTag = process.env.PITLORE_REQUESTED_TAG;
const refType = process.env.PITLORE_REF_TYPE;
const refName = process.env.PITLORE_REF_NAME;

function fail(message) {
  throw new Error(`release ref validation failed: ${message}`);
}

if (!requestedTag || !refType || !refName) {
  fail("requested tag, ref type, and ref name are required");
}
if (refType !== "tag") {
  fail("the workflow must be dispatched from an existing Git tag");
}
if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(requestedTag)) {
  fail("requested tag must use vX.Y.Z release SemVer");
}
if (requestedTag !== refName) {
  fail(`requested tag ${requestedTag} does not equal workflow ref ${refName}`);
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const version = requestedTag.slice(1);
if (
  manifest.name !== "pitlore" ||
  manifest.version !== version ||
  manifest.repository?.url !==
    "git+https://github.com/Hardboiled98k/pitlore.git"
) {
  fail("tag version does not match the checked-out package manifest");
}

const expectedCommit = process.env.PITLORE_GITHUB_SHA;
let commit;
if (expectedCommit) {
  if (process.env.PITLORE_REF_PROTECTED !== "true") {
    fail("release tag is not covered by an active GitHub ruleset");
  }
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const tagCommit = execFileSync(
    "git",
    ["rev-parse", `refs/tags/${requestedTag}^{commit}`],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
  if (commit !== expectedCommit || tagCommit !== expectedCommit) {
    fail("checked-out commit, tag target, and GitHub event SHA differ");
  }
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", expectedCommit, "refs/remotes/origin/main"],
    { cwd: projectRoot, stdio: "pipe" },
  );
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (status.trim()) fail("release checkout is not clean");
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `commit=${commit ?? ""}\ntag=${requestedTag}\nversion=${version}\n`,
  );
}
console.log(JSON.stringify({ commit, tag: requestedTag, version }));
