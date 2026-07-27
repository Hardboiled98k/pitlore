import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is required to run the package smoke test");
}
const consumerRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pitlore package-")),
);
const npxRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pitlore npx-")),
);
const globalRoot = path.join(consumerRoot, "global");

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
  return execFileSync(
    process.execPath,
    [npmExecPath, "--dry-run=false", "--json=false", ...args],
    {
      ...execOptions,
      env: isolatedNpmEnv(env),
    },
  );
}

function resolveSuppliedArchive(input) {
  const supplied = path.resolve(projectRoot, input);
  const stat = fs.statSync(supplied);
  if (stat.isFile()) return supplied;
  if (!stat.isDirectory()) {
    throw new Error(`package smoke input is not a file or directory: ${input}`);
  }

  const archives = fs
    .readdirSync(supplied)
    .filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(
      `package smoke directory must contain exactly one .tgz file: ${input}`,
    );
  }
  return path.join(supplied, archives[0]);
}

function inspectArchive(archive) {
  const compressed = fs.readFileSync(archive);
  let tar;
  try {
    tar = zlib.gunzipSync(compressed, { maxOutputLength: 10_000_000 });
  } catch (error) {
    throw new Error(
      "packed artifact is invalid or expands beyond the 10 MB safety limit",
      { cause: error },
    );
  }

  let entryCount = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawSize = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/u, "")
      .trim();
    if (rawSize && !/^[0-7]+$/u.test(rawSize)) {
      throw new Error("packed artifact contains an unsupported tar size field");
    }
    const entrySize = rawSize ? Number.parseInt(rawSize, 8) : 0;
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
      throw new Error("packed artifact contains an invalid tar entry size");
    }

    entryCount += 1;
    if (entryCount > 500) {
      throw new Error("packed artifact unexpectedly contains more than 500 entries");
    }
    offset += 512 + Math.ceil(entrySize / 512) * 512;
  }

  if (entryCount === 0 || offset > tar.length) {
    throw new Error("packed artifact does not contain a valid non-empty tar archive");
  }
  return { entryCount, tarSize: tar.length };
}

function validateInstalledMarkdownLinks(packageRoot) {
  const markdownFiles = [];
  const pending = [packageRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        markdownFiles.push(entryPath);
      }
    }
  }

  for (const markdownFile of markdownFiles) {
    const markdown = fs.readFileSync(markdownFile, "utf8");
    for (const match of markdown.matchAll(/\]\(([^)\r\n]+)\)/gu)) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
      } else {
        target = target.split(/\s+["']/u, 1)[0];
      }
      if (
        !target ||
        target.startsWith("#") ||
        target.startsWith("/") ||
        /^[a-z][a-z0-9+.-]*:/iu.test(target)
      ) {
        continue;
      }

      const withoutAnchor = target.split(/[?#]/u, 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(withoutAnchor);
      } catch (error) {
        throw new Error(
          `packaged Markdown contains an invalid relative URL in ${path.relative(
            packageRoot,
            markdownFile,
          )}: ${target}`,
          { cause: error },
        );
      }
      const resolved = path.resolve(path.dirname(markdownFile), decoded);
      if (
        (resolved !== packageRoot &&
          !resolved.startsWith(`${packageRoot}${path.sep}`)) ||
        !fs.existsSync(resolved)
      ) {
        throw new Error(
          `packaged Markdown link does not resolve inside the artifact: ${path.relative(
            packageRoot,
            markdownFile,
          )} -> ${target}`,
        );
      }
    }
  }
}

try {
  let archive;
  if (process.argv[2]) {
    archive = resolveSuppliedArchive(process.argv[2]);
  } else {
    const packOutput = runNpm(
      ["pack", "--pack-destination", consumerRoot, "--silent"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    const packedName = packOutput.trim().split(/\r?\n/).at(-1);
    if (!packedName) throw new Error("npm pack did not return an archive name");
    archive = path.join(consumerRoot, packedName);
  }
  const archiveName = path.basename(archive);
  const archiveSize = fs.statSync(archive).size;
  if (archiveSize === 0 || archiveSize > 2_000_000) {
    throw new Error("packed artifact is empty or unexpectedly exceeds 2 MB");
  }
  const archiveInspection = inspectArchive(archive);
  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "pitlore-smoke": "pitlore --help" },
    }),
    "utf8",
  );
  runNpm(
    [
      "install",
      "--prefix",
      consumerRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "pitlore");
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"),
  );
  validateInstalledMarkdownLinks(installedRoot);
  const declarationsReferenceSdk = fs
    .readdirSync(path.join(installedRoot, "dist"))
    .filter((name) => name.endsWith(".d.ts"))
    .some((name) =>
      fs
        .readFileSync(path.join(installedRoot, "dist", name), "utf8")
        .includes("@modelcontextprotocol/sdk"),
    );
  const binary = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pitlore.cmd" : "pitlore",
  );
  const cliEntry = path.join(installedRoot, "dist", "cli.js");
  const cliCommand = process.platform === "win32" ? process.execPath : binary;
  const cliPrefix = process.platform === "win32" ? [cliEntry] : [];
  const runCli = (args, options) =>
    execFileSync(cliCommand, [...cliPrefix, ...args], options);
  const spawnCli = (args, options) =>
    spawnSync(cliCommand, [...cliPrefix, ...args], options);
  const installedBinHelp = runNpm(["run", "--silent", "pitlore-smoke"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const mcpInput = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-smoke", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const mcpProbe = spawnCli(
    ["serve", "--lore", path.join(installedRoot, "seed")],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      input: `${mcpInput}\n`,
      timeout: 15_000,
    },
  );
  if (mcpProbe.error) throw mcpProbe.error;
  if (mcpProbe.signal) {
    throw new Error(`installed MCP probe terminated by ${mcpProbe.signal}`);
  }
  const mcpMessages = (mcpProbe.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const help = runCli(["--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const version = runCli(["--version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const initialized = runCli(["init", "--name", "package-smoke"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const search = runCli(["search", "async"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const reviewQueue = runCli(["review-queue"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const rejectInput = path.join(consumerRoot, "package-reject-candidate.json");
  fs.writeFileSync(
    rejectInput,
    JSON.stringify({
      id: "package-reject-candidate",
      title: "Installed CLI can reject candidates",
      languages: ["typescript"],
      category: "governance",
      symptom: "A candidate should leave the active review queue",
      root_cause: "The installed artifact lacked a rejection transition",
      forbid_pattern_abstract: "Treating an advisory rejection as a final decision",
      safe_pattern_abstract: "Require the explicit human-only reject CLI action",
      status: "candidate",
      visibility: "private",
    }),
    "utf8",
  );
  runCli(["add", rejectInput], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const rejected = runCli(
    ["reject", "package-reject-candidate"],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  const rejectedSearch = runCli(
    ["search", "package-reject", "--status", "rejected"],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  const rejectedLesson = JSON.parse(
    runCli(["get", "package-reject-candidate"], {
      cwd: consumerRoot,
      encoding: "utf8",
    }),
  );
  const deprecateInput = path.join(
    consumerRoot,
    "package-deprecate-candidate.json",
  );
  fs.writeFileSync(
    deprecateInput,
    fs.readFileSync(rejectInput, "utf8").replaceAll(
      "package-reject-candidate",
      "package-deprecate-candidate",
    ),
    "utf8",
  );
  runCli(["add", deprecateInput], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  runCli(["approve", "package-deprecate-candidate"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const deprecated = runCli(
    ["deprecate", "package-deprecate-candidate"],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  const deprecatedLesson = JSON.parse(
    runCli(["get", "package-deprecate-candidate"], {
      cwd: consumerRoot,
      encoding: "utf8",
    }),
  );
  const packSource = path.join(consumerRoot, "public-pack");
  fs.mkdirSync(path.join(packSource, "lessons"), { recursive: true });
  fs.writeFileSync(
    path.join(packSource, "manifest.yaml"),
    JSON.stringify({
      name: "pitlore/package-smoke",
      description: "Installed artifact Pack smoke",
      visibility: "public",
      version: "1.0.0",
      dependencies: {},
      default_status_for_new: "candidate",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packSource, "LICENSE"),
    "Apache License 2.0 package smoke fixture\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(packSource, "lessons", "package-pack-timeout.yaml"),
    JSON.stringify({
      id: "package-pack-timeout",
      version: "1.0.0",
      title: "Public package Pack Lesson",
      languages: ["typescript"],
      category: "reliability",
      symptom: "A remote request can hang",
      root_cause: "No bounded deadline",
      forbid_pattern_abstract: "Unbounded remote calls",
      safe_pattern_abstract: "Use a bounded deadline",
      status: "approved",
      visibility: "public",
    }),
    "utf8",
  );
  const packInstall = runCli(["install", packSource], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const packVerify = runCli(["pack", "verify-installed"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const installedPackLesson = JSON.parse(
    runCli(["get", "package-pack-timeout"], {
      cwd: consumerRoot,
      encoding: "utf8",
    }),
  );
  const retrieval = JSON.parse(
    runCli(
      [
        "retrieve",
        "--intent",
        "async foreach promises",
        "--language",
        "typescript",
        "--files",
        "src/worker.ts",
        "tests/worker.test.ts",
        "--json",
        "--with-context",
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    ),
  );
  const evidenceRecord = spawnCli(
    ["evidence", "record", "--input", "-"],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      input: JSON.stringify({
        type: "retrieve_observation",
        observation_id: "package-smoke-retrieve",
        task_id: "package-smoke",
        client: "cli",
        sample_kind: "smoke",
        observed_catalog_hash: retrieval.observed_catalog_hash,
        returned_lesson_ids: ["js-foreach-async-await-miss"],
        used_lesson_ids: ["js-foreach-async-await-miss"],
        irrelevant_lesson_ids: [],
        missed_existing_lesson_ids: [],
        coverage_gap: false,
        reason: "Installed artifact evidence command round trip",
      }),
    },
  );
  const evidenceSummary = JSON.parse(
    runCli(["evidence", "summary", "--json"], {
      cwd: consumerRoot,
      encoding: "utf8",
    }),
  );
  const badFixture = path.join(
    installedRoot,
    "demo",
    "fixtures",
    "bad-foreach-async.js",
  );
  const blocked = spawnCli(["check", badFixture], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  runNpm(
    [
      "install",
      "--global",
      "--prefix",
      globalRoot,
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      archive,
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );
  const globalInstalledRoot =
    process.platform === "win32"
      ? path.join(globalRoot, "node_modules", "pitlore")
      : path.join(globalRoot, "lib", "node_modules", "pitlore");
  const globalCliEntry = path.join(globalInstalledRoot, "dist", "cli.js");
  const globalBinRoot =
    process.platform === "win32" ? globalRoot : path.join(globalRoot, "bin");
  const globalBinary = path.join(
    globalBinRoot,
    process.platform === "win32" ? "pitlore.cmd" : "pitlore",
  );
  const environmentPathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const inheritedPath = process.env[environmentPathKey] ?? "";
  fs.writeFileSync(
    path.join(npxRoot, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "pitlore-global-version": "pitlore --version" },
    }),
    "utf8",
  );
  const globalVersion = runNpm(
    ["run", "--silent", "pitlore-global-version"],
    {
      cwd: npxRoot,
      encoding: "utf8",
      env: {
        [environmentPathKey]: inheritedPath
          ? `${globalBinRoot}${path.delimiter}${inheritedPath}`
          : globalBinRoot,
      },
    },
  );
  const npxVersion = runNpm(
    [
      "exec",
      "--yes",
      "--package",
      archive,
      "--",
      "pitlore",
      "--version",
    ],
    { cwd: npxRoot, encoding: "utf8" },
  );
  runNpm(
    [
      "install",
      "--prefix",
      consumerRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "zod@3.25.28",
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );
  const minimumZodVersion = JSON.parse(
    fs.readFileSync(
      path.join(consumerRoot, "node_modules", "zod", "package.json"),
      "utf8",
    ),
  ).version;
  const minimumZodHelp = runCli(["--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
  });

  if (
    !installedBinHelp.includes("PitLore") ||
    Object.hasOwn(
      installedManifest.dependencies ?? {},
      "@modelcontextprotocol/sdk",
    ) ||
    declarationsReferenceSdk ||
    fs.existsSync(
      path.join(consumerRoot, "node_modules", "@modelcontextprotocol", "sdk"),
    ) ||
    fs.existsSync(path.join(consumerRoot, "node_modules", "hono")) ||
    fs.existsSync(
      path.join(consumerRoot, "node_modules", "@hono", "node-server"),
    ) ||
    mcpProbe.status !== 0 ||
    mcpMessages.find((message) => message.id === 1)?.result?.serverInfo?.name !==
      "pitlore" ||
    mcpMessages.find((message) => message.id === 1)?.result?.serverInfo
      ?.version !== installedManifest.version ||
    !mcpMessages
      .find((message) => message.id === 2)
      ?.result?.tools?.some((tool) => tool.name === "pitlore_retrieve") ||
    !help.includes("PitLore") ||
    !help.includes("review") ||
    !help.includes("review-queue") ||
    !help.includes("reject") ||
    !help.includes("deprecate") ||
    !help.includes("evidence") ||
    version.trim() !== installedManifest.version ||
    !initialized.includes("Initialized PitLore") ||
    !fs.existsSync(
      path.join(consumerRoot, ".pitlore", "manifest.yaml"),
    ) ||
    !search.includes("lesson(s)") ||
    !reviewQueue.includes("No candidate lessons") ||
    !rejected.includes("Rejected package-reject-candidate") ||
    !rejectedSearch.includes("package-reject-candidate") ||
    rejectedLesson.status !== "rejected" ||
    !deprecated.includes("Deprecated package-deprecate-candidate") ||
    deprecatedLesson.status !== "deprecated" ||
    !packInstall.includes("Installed pitlore/package-smoke@1.0.0") ||
    !packVerify.includes("Verified 1 locked Pack(s)") ||
    installedPackLesson.id !== "package-pack-timeout" ||
    !/^[a-f0-9]{64}$/.test(retrieval.observed_catalog_hash) ||
    !Array.isArray(retrieval.results) ||
    !retrieval.results.some(
      (item) => item.lesson?.id === "js-foreach-async-await-miss",
    ) ||
    evidenceRecord.status !== 0 ||
    !evidenceRecord.stdout.includes("Recorded retrieve_observation") ||
    evidenceSummary.total_events !== 1 ||
    evidenceSummary.sample_counts.smoke !== 1 ||
    evidenceSummary.retrieve.real_observations !== 0 ||
    evidenceSummary.retrieve.precision !== null ||
    blocked.status !== 2 ||
    !blocked.stdout.includes("observed_catalog_hash") ||
    !blocked.stdout.includes("js-foreach-async-await-miss") ||
    globalVersion.trim() !== installedManifest.version ||
    npxVersion.trim() !== installedManifest.version ||
    !fs.existsSync(globalBinary) ||
    !fs.existsSync(globalCliEntry) ||
    minimumZodVersion !== "3.25.28" ||
    !minimumZodHelp.includes("PitLore") ||
    !fs.existsSync(binary) ||
    !fs.existsSync(cliEntry) ||
    !fs.existsSync(path.join(installedRoot, "LICENSE")) ||
    !fs.existsSync(path.join(installedRoot, "CHANGELOG.md")) ||
    !fs.existsSync(path.join(installedRoot, "CONTRIBUTING.md")) ||
    !fs.existsSync(path.join(installedRoot, "SECURITY.md")) ||
    !fs.existsSync(path.join(installedRoot, "SUPPORT.md")) ||
    !fs.existsSync(path.join(installedRoot, "THIRD_PARTY_NOTICES.md")) ||
    !fs.existsSync(
      path.join(installedRoot, "packs", "node-reliability", "manifest.yaml"),
    )
  ) {
    throw new Error("installed package did not expose a working CLI and seed lore");
  }
  console.log(
    `Package smoke passed: ${archiveName} (${archiveInspection.entryCount} tar entries, ${archiveInspection.tarSize} expanded bytes)`,
  );
} finally {
  fs.rmSync(consumerRoot, { recursive: true, force: true });
  fs.rmSync(npxRoot, { recursive: true, force: true });
}
