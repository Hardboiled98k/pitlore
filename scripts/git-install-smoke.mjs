import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is required to run the Git install smoke test");
}
const npxExecPath = path.join(path.dirname(npmExecPath), "npx-cli.js");
if (!fs.existsSync(npxExecPath)) {
  throw new Error("npx-cli.js was not found beside npm_execpath");
}

const smokeRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pitlore git install-")),
);
const sourceRoot = path.join(smokeRoot, "source");
const consumerRoot = path.join(smokeRoot, "consumer");

function run(command, args, options = {}) {
  return execFileSync(command, args, options);
}

function isolatedNpmEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "init_cwd" ||
      normalized === "npm_command" ||
      normalized === "npm_execpath" ||
      normalized === "npm_lifecycle_event" ||
      normalized === "npm_lifecycle_script" ||
      normalized === "npm_node_execpath" ||
      normalized === "npm_config_global_prefix" ||
      normalized === "npm_config_local_prefix" ||
      normalized === "npm_config_prefix" ||
      normalized.startsWith("npm_package_")
    ) {
      delete env[key];
    }
  }
  return env;
}

function runNpm(args, options = {}) {
  // `npm publish --dry-run --json` propagates both settings into lifecycle
  // scripts. npm lifecycle path/package variables must also not make the
  // disposable consumer inherit this repository as its local project.
  const { env, ...execOptions } = options;
  return run(
    process.execPath,
    [npmExecPath, "--dry-run=false", "--json=false", ...args],
    {
      ...execOptions,
      env: isolatedNpmEnv(env),
    },
  );
}

function runNpx(args, options = {}) {
  const { env, ...execOptions } = options;
  return run(
    process.execPath,
    [npxExecPath, "--dry-run=false", "--json=false", ...args],
    {
      ...execOptions,
      env: isolatedNpmEnv(env),
    },
  );
}

function listPublicWorktreeFiles(worktreeRoot) {
  const listed = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: worktreeRoot },
  );
  const deleted = new Set(
    run("git", ["ls-files", "--deleted", "-z"], { cwd: worktreeRoot })
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  return listed
    .toString("utf8")
    .split("\0")
    .filter(
      (relativePath) =>
        relativePath &&
        !relativePath.endsWith(".tgz") &&
        !deleted.has(relativePath),
    );
}

function copyPublicWorktree() {
  const relativePaths = listPublicWorktreeFiles(projectRoot);
  for (const relativePath of relativePaths) {
    const source = path.resolve(projectRoot, relativePath);
    const destination = path.resolve(sourceRoot, relativePath);
    if (
      !source.startsWith(`${projectRoot}${path.sep}`) ||
      !destination.startsWith(`${sourceRoot}${path.sep}`)
    ) {
      throw new Error(`Git listed an unsafe path: ${relativePath}`);
    }

    const stat = fs.lstatSync(source);
    if (!stat.isFile()) {
      throw new Error(`Git install fixture requires a regular file: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
  }
}

function verifyDeletedWorktreeFilesAreExcluded() {
  const probeRoot = path.join(smokeRoot, "listing-probe");
  fs.mkdirSync(probeRoot, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: probeRoot });
  run("git", ["config", "user.name", "PitLore install smoke"], {
    cwd: probeRoot,
  });
  run("git", ["config", "user.email", "install-smoke@example.invalid"], {
    cwd: probeRoot,
  });
  fs.writeFileSync(path.join(probeRoot, "keep.txt"), "keep\n", "utf8");
  fs.writeFileSync(path.join(probeRoot, "deleted.txt"), "delete\n", "utf8");
  run("git", ["add", "--all"], { cwd: probeRoot });
  run(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "listing probe"],
    { cwd: probeRoot },
  );
  fs.rmSync(path.join(probeRoot, "deleted.txt"));
  fs.writeFileSync(path.join(probeRoot, "untracked.txt"), "new\n", "utf8");

  const listed = listPublicWorktreeFiles(probeRoot).sort();
  if (JSON.stringify(listed) !== JSON.stringify(["keep.txt", "untracked.txt"])) {
    throw new Error(
      `Git worktree listing did not exclude a tracked deletion: ${listed.join(", ")}`,
    );
  }
}

try {
  verifyDeletedWorktreeFilesAreExcluded();
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(consumerRoot, { recursive: true });
  copyPublicWorktree();
  if (fs.existsSync(path.join(sourceRoot, "dist"))) {
    throw new Error(
      "Git install fixture must start from source without a prepared dist",
    );
  }

  run("git", ["init", "--quiet"], { cwd: sourceRoot });
  run("git", ["config", "user.name", "PitLore install smoke"], {
    cwd: sourceRoot,
  });
  run("git", ["config", "user.email", "install-smoke@example.invalid"], {
    cwd: sourceRoot,
  });
  run("git", ["add", "--all"], { cwd: sourceRoot });
  run(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "smoke source"],
    { cwd: sourceRoot },
  );
  run("git", ["branch", "--move", "main"], { cwd: sourceRoot });
  const sourceCommit = run("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();

  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "pitlore-version": "pitlore --version" },
    }),
    "utf8",
  );

  const gitSpec = `git+${pathToFileURL(sourceRoot).href}#main`;
  runNpm(
    [
      "install",
      "--prefix",
      consumerRoot,
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--save-dev",
      gitSpec,
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "pitlore");
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"),
  );
  const consumerLock = JSON.parse(
    fs.readFileSync(path.join(consumerRoot, "package-lock.json"), "utf8"),
  );
  const lockedPackage = consumerLock.packages?.["node_modules/pitlore"];
  const cliEntry = path.join(installedRoot, "dist", "cli.js");
  const binary = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pitlore.cmd" : "pitlore",
  );
  const version = runNpm(["run", "--silent", "pitlore-version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const help = run(process.execPath, [cliEntry, "--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const documentedVersion = runNpx(
    ["--no-install", "pitlore", "--version"],
    {
      cwd: consumerRoot,
      encoding: "utf8",
    },
  );
  const documentedInit = runNpx(
    ["--no-install", "pitlore", "init", "--name", "my-project"],
    {
      cwd: consumerRoot,
      encoding: "utf8",
    },
  );
  const documentedRetrieve = runNpx(
    [
      "--no-install",
      "pitlore",
      "retrieve",
      "-i",
      "async array iteration",
      "-l",
      "typescript",
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
    },
  );

  const failedChecks = [
    ["npm script version", version.trim() === installedManifest.version],
    [
      "documented npx version",
      documentedVersion.trim() === installedManifest.version,
    ],
    ["documented init", documentedInit.includes("Initialized PitLore")],
    [
      "documented retrieve",
      documentedRetrieve.includes("observed_catalog_hash"),
    ],
    ["CLI help", help.includes("PitLore")],
    ["consumer bin", fs.existsSync(binary)],
    ["prepared CLI entry", fs.existsSync(cliEntry)],
    [
      "initialized lore manifest",
      fs.existsSync(path.join(consumerRoot, ".pitlore", "manifest.yaml")),
    ],
    [
      "lockfile package version",
      lockedPackage?.version === installedManifest.version,
    ],
    [
      "lockfile requested branch",
      consumerLock.packages?.[""]?.devDependencies?.pitlore === gitSpec,
    ],
    [
      "lockfile resolved commit",
      typeof lockedPackage?.resolved === "string" &&
        lockedPackage.resolved.endsWith(`#${sourceCommit}`),
    ],
    ["source excluded from install", !fs.existsSync(path.join(installedRoot, "src"))],
  ]
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new Error(
      `Git-installed package checks failed: ${failedChecks.join(", ")}`,
    );
  }

  console.log(`Git install smoke passed: pitlore@${installedManifest.version}`);
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}
