import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const lockfilePath = path.resolve(
  projectRoot,
  process.argv[2] ?? "package-lock.json",
);
const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));

if (lockfile.lockfileVersion !== 3) {
  throw new Error(
    `Expected npm lockfileVersion 3, received ${lockfile.lockfileVersion}`,
  );
}
const root = lockfile.packages?.[""];
if (
  root?.name !== manifest.name ||
  root?.version !== manifest.version ||
  lockfile.name !== manifest.name ||
  lockfile.version !== manifest.version
) {
  throw new Error("package-lock root name/version does not match package.json");
}

const officialRegistry = "https://registry.npmjs.org/";
const resolvedEntries = [];
const disallowed = [];
for (const [packagePath, entry] of Object.entries(lockfile.packages ?? {})) {
  if (!entry || typeof entry !== "object" || typeof entry.resolved !== "string") {
    continue;
  }
  resolvedEntries.push(packagePath);
  if (!entry.resolved.startsWith(officialRegistry)) {
    disallowed.push(`${packagePath || "<root>"} -> ${entry.resolved}`);
  }
}

if (resolvedEntries.length === 0) {
  throw new Error("package-lock does not contain any resolved artifacts");
}
if (disallowed.length > 0) {
  throw new Error(
    `package-lock contains non-official resolved artifacts:\n${disallowed.join(
      "\n",
    )}`,
  );
}

console.log(
  `Verified ${resolvedEntries.length} package-lock artifacts from ${officialRegistry}`,
);
