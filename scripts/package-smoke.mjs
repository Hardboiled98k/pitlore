import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is required to run the package smoke test");
}
const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore package-"));

function runNpm(args, options) {
  return execFileSync(process.execPath, [npmExecPath, ...args], options);
}

try {
  const packOutput = runNpm(
    ["pack", "--pack-destination", consumerRoot, "--silent"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const archiveName = packOutput.trim().split(/\r?\n/).at(-1);
  if (!archiveName) throw new Error("npm pack did not return an archive name");

  const archive = path.join(consumerRoot, archiveName);
  if (fs.statSync(archive).size > 2_000_000) {
    throw new Error("packed artifact unexpectedly exceeds 2 MB");
  }
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
      "zod@3.25.28",
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "pitlore");
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"),
  );
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
    !mcpMessages
      .find((message) => message.id === 2)
      ?.result?.tools?.some((tool) => tool.name === "pitlore_retrieve") ||
    !help.includes("PitLore") ||
    !help.includes("review") ||
    !help.includes("review-queue") ||
    !help.includes("reject") ||
    !help.includes("deprecate") ||
    !help.includes("evidence") ||
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
    !fs.existsSync(binary) ||
    !fs.existsSync(cliEntry) ||
    !fs.existsSync(path.join(installedRoot, "LICENSE")) ||
    !fs.existsSync(path.join(installedRoot, "THIRD_PARTY_NOTICES.md")) ||
    !fs.existsSync(
      path.join(installedRoot, "packs", "node-reliability", "manifest.yaml"),
    )
  ) {
    throw new Error("installed package did not expose a working CLI and seed lore");
  }
  console.log(`Package smoke passed: ${archiveName}`);
} finally {
  fs.rmSync(consumerRoot, { recursive: true, force: true });
}
