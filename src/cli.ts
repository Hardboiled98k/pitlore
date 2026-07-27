#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import yaml from "js-yaml";
import { checkContent, formatFindings } from "./check.js";
import { distillLesson } from "./distill.js";
import {
  formatEvidenceSummary,
  loadEvidence,
  recordEvidence,
  summarizeEvidence,
  type EvidenceCatalogFilter,
} from "./evidence.js";
import { exportAgentsSnippet } from "./export.js";
import { sanitizeLessonForPublic } from "./public-export.js";
import {
  installPack,
  installAirgapPack,
  loadEffectiveStore,
  loadPackLock,
  resolvePackLockPath,
  signPack,
  uninstallPack,
  verifyInstalledPacks,
  verifyPack,
} from "./pack.js";
import {
  createRegistryPackArtifact,
  createRegistryPackBundle,
  installRegistryPackBundle,
  readRegistryPackArtifactFile,
  readRegistryPackBundleFile,
  withMaterializedRegistryPackArtifact,
  withMaterializedRegistryPackBundle,
  writeRegistryPackArtifactFile,
  writeRegistryPackBundleFile,
} from "./registry-artifact.js";
import { startMcpServer } from "./mcp-server.js";
import { defaultProjectLore, resolveLoreRoot, seedDir } from "./paths.js";
import { formatLessonsForPrompt, rankLessons } from "./retrieve.js";
import { RegistryHttpClient } from "./registry-client.js";
import {
  distillFixSignal,
  fixSignalFromCi,
  fixSignalFromSentryResolved,
  ingestFixSignal,
  type FixSignal,
} from "./signal.js";
import { applyRegistryMigrations } from "./registry-postgres.js";
import { reindexRegistryReleaseDiscovery } from "./registry-discovery-reindex.js";
import {
  bootstrapPostgresRegistry,
  createPostgresRegistryRuntime,
  createRegistryPostgresPoolFromEnvironment,
  createRegistryPostgresPoolFromRequiredUrlEnvironment,
  issuePostgresBootstrapToken,
  loadRegistryBillingEnvironment,
  loadRegistryBrowserAuthEnvironment,
  loadRegistryOidcEnvironment,
  loadRegistryTrustProxyEnvironment,
} from "./registry-runtime.js";
import {
  buildReviewPacket,
  buildReviewQueue,
  formatReviewQueue,
  recordCandidateReview,
} from "./review.js";
import {
  StatusSchema,
  validateLesson,
  validateReviewEnvelope,
  type Lesson,
} from "./schema.js";
import {
  approvedCatalogHash,
  approveLesson,
  deprecateLesson,
  ensureWritableLoreRoot,
  getLesson,
  initLore,
  listLessons,
  loadStore,
  putLesson,
  rejectLesson,
} from "./store.js";

const program = new Command();

program
  .name("pitlore")
  .description(
    "PitLore — executable pit lore for coding agents (lessons from past bugs)",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a local .pitlore lore store in the current project")
  .option("-n, --name <name>", "Lore name")
  .option("--no-seed", "Do not copy bundled seed lessons")
  .option("--home", "Initialize under ~/.pitlore/lore instead of ./.pitlore")
  .option(
    "--path <path>",
    "Initialize a custom lore root (for a team Git repo)",
  )
  .action(
    (opts: {
      name?: string;
      seed?: boolean;
      home?: boolean;
      path?: string;
    }) => {
      if (opts.home && opts.path) {
        throw new Error("--home and --path cannot be used together");
      }
      const configuredRoot = process.env.PITLORE_LORE?.trim();
      const root = opts.path
        ? path.resolve(opts.path)
        : opts.home
          ? path.join(
              process.env.HOME || process.env.USERPROFILE || ".",
              ".pitlore",
              "lore",
            )
          : configuredRoot
            ? path.resolve(configuredRoot)
            : defaultProjectLore();
      const store = initLore(root, {
        name: opts.name,
        copySeed: opts.seed !== false,
        seedDir: seedDir(),
      });
      console.log(`Initialized PitLore at ${store.root}`);
      console.log(`Lessons: ${store.lessons.length}`);
      console.log(`Manifest: ${store.manifest.name}`);
    },
  );

program
  .command("search")
  .description("Search lessons")
  .argument("[query]", "search text")
  .option("-l, --language <lang>", "filter by language")
  .option(
    "-s, --status <status>",
    "candidate|approved|rejected|deprecated|all",
    "approved",
  )
  .action(
    (
      query: string | undefined,
      opts: { language?: string; status: Lesson["status"] | "all" },
    ) => {
      if (opts.status !== "all") StatusSchema.parse(opts.status);
      const store = loadEffectiveStore();
      const items = listLessons(store, {
        q: query,
        language: opts.language,
        status: opts.status,
      });
      if (items.length === 0) {
        console.log("No lessons matched.");
        return;
      }
      for (const l of items) {
        console.log(
          `${l.status.padEnd(10)} ${l.severity.padEnd(5)} ${l.id}  — ${l.title}`,
        );
      }
      console.log(`\n${items.length} lesson(s) from ${store.root}`);
    },
  );

program
  .command("get")
  .description("Show one lesson as JSON")
  .argument("<id>", "lesson id")
  .action((id: string) => {
    const store = loadEffectiveStore();
    const lesson = getLesson(store, id);
    if (!lesson) {
      console.error(`Not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(lesson, null, 2));
  });

program
  .command("retrieve")
  .description("Rank lessons for an intent / file set")
  .option("-i, --intent <text>", "task intent")
  .option("-f, --file <path>", "file path (repeatable)", collect, [])
  .option(
    "--files <paths...>",
    "file paths (space-separated compatibility alias)",
  )
  .option("-l, --language <lang>", "language (repeatable)", collect, [])
  .option("-k, --top <n>", "top K", "5")
  .option("--json", "raw JSON")
  .option(
    "--with-context",
    "include the observed approved catalog hash for later evidence recording",
  )
  .action(
    (opts: {
      intent?: string;
      file: string[];
      files?: string[];
      language: string[];
      top: string;
      json?: boolean;
      withContext?: boolean;
    }) => {
      const top = Number(opts.top);
      if (!Number.isInteger(top) || top < 1 || top > 20) {
        throw new Error("--top must be an integer between 1 and 20");
      }
      const files = [...opts.file, ...(opts.files ?? [])];
      const store = loadEffectiveStore();
      const ranked = rankLessons(store, {
        intent: opts.intent,
        files,
        languages: opts.language,
        k: top,
      });
      const observedCatalogHash = approvedCatalogHash(store);
      if (opts.json) {
        console.log(
          JSON.stringify(
            opts.withContext
              ? {
                  observed_catalog_hash: observedCatalogHash,
                  results: ranked,
                }
              : ranked,
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `PitLore evidence context (copy into a later observation):\nobserved_catalog_hash: ${observedCatalogHash}\n\n${formatLessonsForPrompt(ranked)}`,
      );
    },
  );

program
  .command("check")
  .description("Scan a file or stdin against lesson patterns")
  .argument("[file]", "file path (omit to read stdin)")
  .option("--all", "include candidate lessons")
  .action(async (file: string | undefined, opts: { all?: boolean }) => {
    const store = loadEffectiveStore();
    const content = file ? fs.readFileSync(file, "utf8") : await readStdin();
    const result = checkContent(store, content, {
      filePath: file,
      onlyApproved: !opts.all,
    });
    console.log(
      `PitLore evidence context (copy into a later observation):\nobserved_catalog_hash: ${approvedCatalogHash(store)}\n\n${formatFindings(result)}`,
    );
    if (!result.clean) {
      const blocked = result.findings.some((f) => f.severity === "block");
      process.exitCode = blocked ? 2 : 1;
    }
  });

program
  .command("add")
  .description("Add a lesson from a YAML file")
  .argument("<file>", "path to lesson yaml")
  .action((file: string) => {
    const storeRoot = writableLoreRoot();
    const raw = fs.readFileSync(file, "utf8");
    const data = yaml.load(raw);
    const lesson = validateLesson(data);
    const saved = putLesson(storeRoot, lesson, { overwrite: false });
    console.log(`Wrote ${saved}`);
  });

program
  .command("distill")
  .description(
    "Distill a bug description into a candidate lesson (uses OPENAI_API_KEY if set)",
  )
  .requiredOption(
    "-d, --description <text>",
    "what went wrong / what was fixed",
  )
  .option("-l, --language <lang>", "language", "typescript")
  .option("--ecosystem <eco>", "ecosystem tag", collect, [])
  .option("--diff <text>", "optional fix summary")
  .option("--id <id>", "id hint")
  .option("--dry-run", "print only, do not write")
  .action(
    async (opts: {
      description: string;
      language: string;
      ecosystem: string[];
      diff?: string;
      id?: string;
      dryRun?: boolean;
    }) => {
      const lesson = await distillLesson({
        description: opts.description,
        languages: [opts.language],
        ecosystems: opts.ecosystem,
        diffSummary: opts.diff,
        idHint: opts.id,
      });
      if (opts.dryRun) {
        console.log(JSON.stringify(lesson, null, 2));
        return;
      }
      const root = writableLoreRoot();
      const file = putLesson(root, lesson, { overwrite: false });
      console.log(`Saved ${lesson.status} lesson ${lesson.id}`);
      console.log(file);
    },
  );

program
  .command("review")
  .description(
    "Prepare or record an advisory LLM review without changing lifecycle state",
  )
  .argument("<id>", "candidate lesson id")
  .option(
    "--input <file>",
    'structured review envelope JSON from an LLM (use "-" for stdin)',
  )
  .action(async (id: string, opts: { input?: string }) => {
    if (!opts.input) {
      const root = loadStore().root;
      console.log(JSON.stringify(buildReviewPacket(root, id), null, 2));
      return;
    }

    const raw =
      opts.input === "-"
        ? await readStdin()
        : fs.readFileSync(opts.input, "utf8");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid review JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const envelope = validateReviewEnvelope(input);
    const root = writableLoreRoot();
    const { review, file } = recordCandidateReview(
      root,
      id,
      envelope.submission,
      envelope.review_context_hash,
    );
    console.log(
      `Recorded LLM review for ${id}: ${review.recommendation} (${Math.round(review.confidence * 100)}%)`,
    );
    console.log(
      `Candidate remains unapproved. Human decision is still required.`,
    );
    console.log(file);
  });

program
  .command("review-queue")
  .description("Show current, stale, and missing LLM reviews for candidates")
  .option("--json", "print structured JSON")
  .action((opts: { json?: boolean }) => {
    const root = loadStore().root;
    const queue = buildReviewQueue(root);
    console.log(
      opts.json ? JSON.stringify(queue, null, 2) : formatReviewQueue(queue),
    );
  });

const evidence = program
  .command("evidence")
  .description(
    "Record explicit local dogfood judgments and summarize real retrieval/detector evidence",
  );

evidence
  .command("record")
  .description(
    "Append one validated retrieve or detector observation (never records prompts or source content)",
  )
  .requiredOption("--input <file>", 'observation JSON (use "-" for stdin)')
  .action(async (opts: { input: string }) => {
    const raw =
      opts.input === "-"
        ? await readStdin()
        : fs.readFileSync(opts.input, "utf8");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { event, file, created } = recordEvidence(writableLoreRoot(), input);
    console.log(
      created
        ? `Recorded ${event.type} ${event.event_id}`
        : `Evidence already recorded ${event.type} ${event.event_id}`,
    );
    console.log(file);
  });

evidence
  .command("summary")
  .description(
    "Summarize evidence; only real observations contribute to usefulness, precision, and recall",
  )
  .option("--json", "print structured JSON")
  .option(
    "--catalog <scope>",
    'catalog scope: "all", "current", or a 64-character catalog hash',
    "all",
  )
  .action((opts: { json?: boolean; catalog: string }) => {
    const requestedCatalog = opts.catalog.trim();
    if (
      requestedCatalog !== "all" &&
      requestedCatalog !== "current" &&
      !/^[a-f0-9]{64}$/.test(requestedCatalog)
    ) {
      throw new Error(
        '--catalog must be "all", "current", or a 64-character lowercase SHA-256',
      );
    }
    const ledger = loadEvidence();
    const filter: EvidenceCatalogFilter =
      requestedCatalog === "all"
        ? { mode: "all" }
        : requestedCatalog === "current"
          ? {
              mode: "current",
              catalog_hash: approvedCatalogHash(
                loadEffectiveStore(ledger.root),
              ),
            }
          : { mode: "hash", catalog_hash: requestedCatalog };
    const summary = summarizeEvidence(ledger, filter);
    console.log(
      opts.json
        ? JSON.stringify(summary, null, 2)
        : formatEvidenceSummary(summary),
    );
  });

const signal = program
  .command("signal")
  .description(
    "Turn bounded resolved CI/Sentry signals into private candidate Lessons",
  );

signal
  .command("ingest")
  .description("Ingest one strict normalized fix-signal JSON document")
  .requiredOption("--input <file>", 'signal JSON (use "-" for stdin)')
  .option("--dry-run", "print candidate only, do not write")
  .option(
    "--use-openai",
    "explicitly send normalized abstract fields to OpenAI",
  )
  .action(
    async (opts: { input: string; dryRun?: boolean; useOpenai?: boolean }) => {
      const input = await readJsonInput(opts.input, "fix signal");
      await handleFixSignal(
        input,
        opts.dryRun ?? false,
        opts.useOpenai ?? false,
      );
    },
  );

signal
  .command("ci")
  .description(
    "Create a candidate from a resolved GitHub Actions or generic CI run",
  )
  .requiredOption(
    "--description <text>",
    "abstract failure mode; never paste logs",
  )
  .requiredOption("--fix <text>", "abstract fix summary; never paste source")
  .option(
    "--event-id <id>",
    "explicit CI event id; otherwise use bounded CI env ids",
  )
  .option("--language <lang>", "language (repeatable)", collect, [])
  .option("--ecosystem <name>", "ecosystem (repeatable)", collect, [])
  .option("--dry-run", "print candidate only, do not write")
  .option(
    "--use-openai",
    "explicitly send normalized abstract fields to OpenAI",
  )
  .action(
    async (opts: {
      description: string;
      fix: string;
      eventId?: string;
      language: string[];
      ecosystem: string[];
      dryRun?: boolean;
      useOpenai?: boolean;
    }) => {
      const input = fixSignalFromCi({
        eventId: opts.eventId,
        description: opts.description,
        fixSummary: opts.fix,
        languages: opts.language.length > 0 ? opts.language : ["typescript"],
        ecosystems: opts.ecosystem,
      });
      await handleFixSignal(
        input,
        opts.dryRun ?? false,
        opts.useOpenai ?? false,
      );
    },
  );

signal
  .command("sentry")
  .description(
    "Extract a resolved Sentry issue id while discarding raw event/user/stack data",
  )
  .requiredOption(
    "--input <file>",
    'Sentry resolved webhook JSON (use "-" for stdin)',
  )
  .requiredOption(
    "--description <text>",
    "operator-written abstract failure mode",
  )
  .requiredOption("--fix <text>", "operator-written abstract fix summary")
  .option("--language <lang>", "language (repeatable)", collect, [])
  .option("--ecosystem <name>", "ecosystem (repeatable)", collect, [])
  .option("--dry-run", "print candidate only, do not write")
  .option(
    "--use-openai",
    "explicitly send normalized abstract fields to OpenAI",
  )
  .action(
    async (opts: {
      input: string;
      description: string;
      fix: string;
      language: string[];
      ecosystem: string[];
      dryRun?: boolean;
      useOpenai?: boolean;
    }) => {
      const webhook = await readJsonInput(opts.input, "Sentry webhook");
      const input = fixSignalFromSentryResolved(webhook, {
        description: opts.description,
        fixSummary: opts.fix,
        languages: opts.language.length > 0 ? opts.language : ["typescript"],
        ecosystems: opts.ecosystem,
      });
      await handleFixSignal(
        input,
        opts.dryRun ?? false,
        opts.useOpenai ?? false,
      );
    },
  );

program
  .command("approve")
  .description("Approve a candidate lesson")
  .argument("<id>", "lesson id")
  .action((id: string) => {
    const root = writableLoreRoot();
    const lesson = approveLesson(root, id);
    console.log(`Approved ${lesson.id}`);
  });

program
  .command("reject")
  .description("Reject a candidate lesson and keep an auditable tombstone")
  .argument("<id>", "lesson id")
  .action((id: string) => {
    const root = writableLoreRoot();
    const lesson = rejectLesson(root, id);
    console.log(`Rejected ${lesson.id}`);
  });

program
  .command("deprecate")
  .description("Retire a previously approved lesson")
  .argument("<id>", "lesson id")
  .action((id: string) => {
    const root = writableLoreRoot();
    const lesson = deprecateLesson(root, id);
    console.log(`Deprecated ${lesson.id}`);
  });

program
  .command("export-agents")
  .description("Print an AGENTS.md snippet from approved lessons")
  .action(() => {
    const store = loadEffectiveStore();
    console.log(exportAgentsSnippet(store.lessons));
  });

program
  .command("export-public")
  .description("Sanitize one approved lesson for explicit public export")
  .argument("<id>", "approved lesson id")
  .action((id: string) => {
    const lesson = getLesson(loadEffectiveStore(), id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    console.log(
      yaml.dump(sanitizeLessonForPublic(lesson), {
        lineWidth: 120,
        noRefs: true,
      }),
    );
  });

program
  .command("install")
  .description(
    "Install and lock a verified public Pack from local path or HTTPS Git",
  )
  .argument("[source]", "local Pack directory or HTTPS Git URL")
  .option("--ref <ref>", "Git branch or tag")
  .option("--subdir <path>", "Pack subdirectory within a repository")
  .option(
    "--trust-key <sha256-id>",
    "require a matching publisher key id",
    collect,
    [],
  )
  .option(
    "--frozen-lockfile",
    "verify the existing lock and cache without changing them",
  )
  .action(
    (
      source: string | undefined,
      opts: {
        ref?: string;
        subdir?: string;
        trustKey: string[];
        frozenLockfile?: boolean;
      },
    ) => {
      if (opts.frozenLockfile) {
        if (source || opts.ref || opts.subdir || opts.trustKey.length > 0) {
          throw new Error(
            "--frozen-lockfile does not accept a source, --ref, --subdir, or --trust-key",
          );
        }
        const root = loadStore().root;
        const lock = verifyInstalledPacks(root);
        console.log(
          `Verified frozen lockfile with ${Object.keys(lock.packages).length} Pack(s)`,
        );
        return;
      }
      if (!source)
        throw new Error(
          "install requires a source unless --frozen-lockfile is used",
        );
      const result = installPack(source, {
        loreRoot: writableLoreRoot(),
        ref: opts.ref,
        subdir: opts.subdir,
        trustedKeyIds: opts.trustKey,
      });
      console.log(
        `${result.created ? "Installed" : result.updated ? "Updated" : "Verified"} ${result.name}@${result.version}`,
      );
      console.log(`Integrity: ${result.integrity}`);
      console.log(`Lockfile: ${result.lockPath}`);
    },
  );

program
  .command("uninstall")
  .description(
    "Remove a root Pack from the lockfile; retained cache remains inert",
  )
  .argument("<name>", "Pack name")
  .action((name: string) => {
    const root = loadStore().root;
    const lock = uninstallPack(name, root);
    console.log(`Uninstalled ${name}`);
    console.log(`${Object.keys(lock.packages).length} Pack(s) remain locked`);
  });

const pack = program
  .command("pack")
  .description("Inspect, sign, and move verified Packs");

pack
  .command("verify")
  .description(
    "Validate a public Pack directory and print its canonical integrity",
  )
  .argument("<path>", "Pack directory")
  .action((packPath: string) => {
    const verified = verifyPack(packPath);
    console.log(
      `${verified.store.manifest.name}@${verified.store.manifest.version}`,
    );
    console.log(`Integrity: ${verified.integrity}`);
    console.log(`Files: ${verified.files.length}`);
  });

pack
  .command("sign")
  .description("Sign a verified public or private Pack payload with Ed25519")
  .argument("<path>", "Pack directory")
  .requiredOption("--private-key <path>", "PEM Ed25519 private key")
  .action((packPath: string, opts: { privateKey: string }) => {
    const signed = signPack(packPath, opts.privateKey);
    if (signed.signature.status !== "verified") {
      throw new Error("Pack signature was not written");
    }
    console.log(
      `Signed ${signed.store.manifest.name}@${signed.store.manifest.version}`,
    );
    console.log(`Key: ${signed.signature.key_id}`);
    console.log(`Integrity: ${signed.integrity}`);
  });

pack
  .command("list")
  .description("List locked Packs")
  .action(() => {
    const root = loadStore().root;
    const lock = loadPackLock(root);
    for (const name of Object.keys(lock.packages).sort()) {
      const entry = lock.packages[name]!;
      console.log(`${name}@${entry.version}  ${entry.integrity}`);
    }
    console.log(
      `${Object.keys(lock.packages).length} Pack(s) from ${resolvePackLockPath(root)}`,
    );
  });

pack
  .command("verify-installed")
  .description("Fail closed unless every locked Pack and dependency verifies")
  .action(() => {
    const root = loadStore().root;
    const lock = verifyInstalledPacks(root);
    console.log(`Verified ${Object.keys(lock.packages).length} locked Pack(s)`);
  });

const packArtifact = pack
  .command("artifact")
  .description("Export, verify, and install portable air-gap Pack artifacts");

packArtifact
  .command("export")
  .description(
    "Export one verified public or private Pack as a canonical artifact file",
  )
  .argument("<path>", "Pack directory")
  .requiredOption("--output <file>", "new artifact JSON file")
  .action((packPath: string, opts: { output: string }) => {
    const artifact = createRegistryPackArtifact(path.resolve(packPath));
    const output = writeRegistryPackArtifactFile(opts.output, artifact);
    console.log(`Exported ${artifact.name}@${artifact.version}`);
    console.log(`Integrity: ${artifact.integrity}`);
    console.log(output);
  });

packArtifact
  .command("verify")
  .description("Verify a canonical air-gap artifact without installing it")
  .argument("<file>", "artifact JSON file")
  .action((file: string) => {
    const artifact = readRegistryPackArtifactFile(file);
    const verified = withMaterializedRegistryPackArtifact(artifact, (pack) => ({
      name: pack.store.manifest.name,
      version: pack.store.manifest.version,
      integrity: pack.integrity,
      files: pack.files.length,
    }));
    console.log(`${verified.name}@${verified.version}`);
    console.log(`Integrity: ${verified.integrity}`);
    console.log(`Files: ${verified.files}`);
  });

packArtifact
  .command("install")
  .description("Install an exact verified artifact without network access")
  .argument("<file>", "artifact JSON file")
  .option("--trust-key <sha256-id>", "require a publisher key id", collect, [])
  .action((file: string, opts: { trustKey: string[] }) => {
    const artifact = readRegistryPackArtifactFile(file);
    const installed = withMaterializedRegistryPackArtifact(artifact, (pack) =>
      installAirgapPack(pack.root, {
        loreRoot: writableLoreRoot(),
        trustedKeyIds: opts.trustKey,
      }),
    );
    console.log(
      `Installed ${installed.name}@${installed.version} from air-gap artifact`,
    );
    console.log(`Integrity: ${installed.integrity}`);
    console.log(`Lockfile: ${installed.lockPath}`);
  });

packArtifact
  .command("bundle-export")
  .description(
    "Export one installed root Pack and its exact dependency closure",
  )
  .argument("<name>", "installed root Pack name")
  .requiredOption("--output <file>", "new bundle JSON file")
  .action((name: string, opts: { output: string }) => {
    const bundle = createRegistryPackBundle(loadStore().root, name);
    const output = writeRegistryPackBundleFile(opts.output, bundle);
    console.log(
      `Exported ${bundle.root} with ${bundle.artifacts.length} Pack(s)`,
    );
    console.log(output);
  });

packArtifact
  .command("bundle-verify")
  .description("Verify every Pack and the exact dependency closure in a bundle")
  .argument("<file>", "bundle JSON file")
  .action((file: string) => {
    const bundle = readRegistryPackBundleFile(file);
    const verified = withMaterializedRegistryPackBundle(
      bundle,
      (_document, packs) =>
        packs.map((pack) => ({
          name: pack.store.manifest.name,
          version: pack.store.manifest.version,
          integrity: pack.integrity,
        })),
    );
    console.log(`Verified ${bundle.root} dependency closure`);
    for (const item of verified) {
      console.log(`${item.name}@${item.version}  ${item.integrity}`);
    }
  });

packArtifact
  .command("bundle-install")
  .description(
    "Atomically lock an exact verified dependency bundle without network access",
  )
  .argument("<file>", "bundle JSON file")
  .option("--trust-key <sha256-id>", "accepted publisher key id", collect, [])
  .action((file: string, opts: { trustKey: string[] }) => {
    const bundle = readRegistryPackBundleFile(file);
    const installed = installRegistryPackBundle(bundle, {
      loreRoot: writableLoreRoot(),
      trustedKeyIds: opts.trustKey,
    });
    console.log(`Installed ${bundle.root} dependency closure`);
    for (const item of installed) {
      console.log(`${item.name}@${item.version}  ${item.integrity}`);
    }
  });

const registry = program
  .command("registry")
  .description("Use a public or self-hosted PitLore Registry");

registry
  .command("search")
  .description("Search public Packs by name and verified release facets")
  .argument("[query]", "package-name search text", "")
  .option("--language <value>", "match a language (repeat up to four)", collect, [])
  .option(
    "--ecosystem <value>",
    "match a framework or ecosystem (repeat up to four)",
    collect,
    [],
  )
  .option("--tag <value>", "match a tag (repeat up to four)", collect, [])
  .option("--facets", "include verified discovery metadata in results")
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .action(async (
    query: string,
    opts: {
      language: string[];
      ecosystem: string[];
      tag: string[];
      facets?: boolean;
      url?: string;
    },
  ) => {
    const client = registryClient(opts);
    const hasFilters =
      opts.language.length > 0 ||
      opts.ecosystem.length > 0 ||
      opts.tag.length > 0;
    console.log(
      JSON.stringify(
        await client.searchPublicPackages(query, {
          languages: opts.language,
          ecosystems: opts.ecosystem,
          tags: opts.tag,
          includeFacets: opts.facets === true || hasFilters,
        }),
        null,
        2,
      ),
    );
  });

registry
  .command("create-package")
  .description("Create an immutable package namespace in an organization")
  .argument("<name>", "namespaced Pack name")
  .requiredOption("--org <uuid>", "organization UUID")
  .option("--visibility <visibility>", "public or private", "private")
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "environment variable containing the bearer token",
    "PITLORE_REGISTRY_TOKEN",
  )
  .action(
    async (
      name: string,
      opts: {
        org: string;
        visibility: "public" | "private";
        url?: string;
        tokenEnv: string;
      },
    ) => {
      const client = registryClient(opts, true);
      console.log(
        JSON.stringify(
          await client.createPackage({
            orgId: opts.org,
            name,
            visibility: opts.visibility,
          }),
          null,
          2,
        ),
      );
    },
  );

registry
  .command("provision-member")
  .description("Pre-provision one OIDC subject as an organization member")
  .requiredOption("--org <uuid>", "organization UUID")
  .requiredOption("--subject <subject>", "exact external OIDC subject claim")
  .requiredOption("--display-name <name>", "member display name")
  .requiredOption("--role <role>", "viewer, publisher, admin, or owner")
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "environment variable containing the owner/admin OIDC bearer",
    "PITLORE_REGISTRY_TOKEN",
  )
  .action(
    async (opts: {
      org: string;
      subject: string;
      displayName: string;
      role: "viewer" | "publisher" | "admin" | "owner";
      url?: string;
      tokenEnv: string;
    }) => {
      const client = registryClient(opts, true);
      console.log(
        JSON.stringify(
          await client.provisionExternalMember({
            orgId: opts.org,
            providerSubject: opts.subject,
            displayName: opts.displayName,
            role: opts.role,
          }),
          null,
          2,
        ),
      );
    },
  );

registry
  .command("publish")
  .description("Verify and upload one complete immutable Pack artifact")
  .argument("<path>", "local public or private Pack directory")
  .requiredOption("--org <uuid>", "organization UUID")
  .requiredOption("--source-url <url>", "credential-free HTTPS Git source")
  .requiredOption(
    "--source-commit <sha>",
    "40 to 64 character lowercase Git commit",
  )
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "environment variable containing the bearer token",
    "PITLORE_REGISTRY_TOKEN",
  )
  .action(
    async (
      packPath: string,
      opts: {
        org: string;
        sourceUrl: string;
        sourceCommit: string;
        url?: string;
        tokenEnv: string;
      },
    ) => {
      const client = registryClient(opts, true);
      console.log(
        JSON.stringify(
          await client.publishPack(path.resolve(packPath), {
            orgId: opts.org,
            sourceUrl: opts.sourceUrl,
            sourceCommit: opts.sourceCommit,
          }),
          null,
          2,
        ),
      );
    },
  );

registry
  .command("install")
  .description(
    "Download, verify, install, and lock an exact Registry Pack version",
  )
  .argument("<name@version>", "exact Pack reference")
  .option("--org <uuid>", "organization UUID for a private Pack")
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "environment variable containing the bearer token",
    "PITLORE_REGISTRY_TOKEN",
  )
  .option("--trust-key <sha256-id>", "require a publisher key id", collect, [])
  .option(
    "--report-usage",
    "opt in to reporting this install to the organization",
  )
  .action(
    async (
      reference: string,
      opts: {
        org?: string;
        url?: string;
        tokenEnv: string;
        trustKey: string[];
        reportUsage?: boolean;
      },
    ) => {
      const client = registryClient(opts, opts.org !== undefined);
      const result = await client.installPack(reference, {
        loreRoot: writableLoreRoot(),
        orgId: opts.org,
        trustedKeyIds: opts.trustKey,
        reportUsage: opts.reportUsage,
      });
      console.log(`Installed ${result.name}@${result.version}`);
      console.log(`Integrity: ${result.integrity}`);
      console.log(`Lockfile: ${result.lockPath}`);
      if (opts.reportUsage) {
        console.log(
          result.usageReported
            ? "Usage: reported with explicit opt-in"
            : `Usage: not reported (${result.usageReportError ?? "unknown"})`,
        );
      }
    },
  );

registry
  .command("sync")
  .description(
    "Revalidate exact locked Registry versions and fail if any release was yanked",
  )
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "optional environment variable containing a bearer for private Packs",
    "PITLORE_REGISTRY_TOKEN",
  )
  .option("--json", "print structured JSON")
  .action(async (opts: { url?: string; tokenEnv: string; json?: boolean }) => {
    const client = registryClient(opts, "optional");
    const result = await client.revalidateInstalledPacks(loadStore().root);
    if (result.checked === 0) {
      throw new Error(`No installed Registry Pack uses ${result.registryUrl}`);
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Revalidated ${result.checked} locked Pack(s) against ${result.registryUrl}`,
      );
      for (const item of result.current) console.log(`Current: ${item}`);
      for (const item of result.yanked) {
        console.error(
          `Yanked: ${item.reference}${item.reason ? ` (${item.reason})` : ""}`,
        );
      }
    }
    if (result.yanked.length > 0) {
      throw new Error(
        `${result.yanked.length} installed Registry Pack release(s) have been yanked`,
      );
    }
  });

registry
  .command("report-usage")
  .description(
    "Send one explicit privacy-safe CI or Sentry-derived usage signal",
  )
  .requiredOption("--org <uuid>", "organization UUID")
  .requiredOption("--event-id <id>", "stable idempotency key")
  .requiredOption(
    "--kind <kind>",
    "install, retrieve, check, or false_positive",
  )
  .requiredOption("--package <name>", "Pack name")
  .requiredOption("--version <version>", "exact Pack version")
  .option("--lesson-id <id>", "abstract Lesson id for false-positive feedback")
  .option("--outcome <outcome>", "hit, clean, used, or irrelevant")
  .option("--occurred-at <timestamp>", "ISO-8601 timestamp")
  .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
  .option(
    "--token-env <name>",
    "environment variable containing the bearer token",
    "PITLORE_REGISTRY_TOKEN",
  )
  .action(
    async (opts: {
      org: string;
      eventId: string;
      kind: "install" | "retrieve" | "check" | "false_positive";
      package: string;
      version: string;
      lessonId?: string;
      outcome?: "hit" | "clean" | "used" | "irrelevant";
      occurredAt?: string;
      url?: string;
      tokenEnv: string;
    }) => {
      const client = registryClient(opts, true);
      console.log(
        JSON.stringify(
          await client.reportUsage(opts.org, {
            eventId: opts.eventId,
            occurredAt: opts.occurredAt ?? new Date().toISOString(),
            kind: opts.kind,
            packageName: opts.package,
            packageVersion: opts.version,
            lessonId: opts.lessonId ?? null,
            outcome: opts.outcome ?? null,
          }),
          null,
          2,
        ),
      );
    },
  );

for (const action of ["approve", "reject", "yank"] as const) {
  const command = registry
    .command(action)
    .description(
      `${action[0]!.toUpperCase()}${action.slice(1)} an exact Registry release`,
    )
    .argument("<name@version>", "exact Pack reference")
    .requiredOption("--org <uuid>", "organization UUID")
    .option("--url <url>", "Registry base URL (or PITLORE_REGISTRY_URL)")
    .option(
      "--token-env <name>",
      "environment variable containing the human bearer assertion",
      "PITLORE_REGISTRY_TOKEN",
    );
  if (action !== "approve") {
    command.requiredOption("--reason <text>", `${action} reason`);
  }
  command.action(
    async (
      reference: string,
      opts: { org: string; url?: string; tokenEnv: string; reason?: string },
    ) => {
      const client = registryClient(opts, true);
      const result =
        action === "approve"
          ? await client.approveRelease(opts.org, reference)
          : action === "reject"
            ? await client.rejectRelease(opts.org, reference, opts.reason ?? "")
            : await client.yankRelease(opts.org, reference, opts.reason ?? "");
      console.log(JSON.stringify(result, null, 2));
    },
  );
}

registry
  .command("migrate")
  .description("Apply checksum-pinned PostgreSQL Registry migrations")
  .option(
    "--database-url-env <name>",
    "environment variable containing the PostgreSQL URL",
    "PITLORE_REGISTRY_DATABASE_URL",
  )
  .action(async (opts: { databaseUrlEnv: string }) => {
    const pool = createRegistryPostgresPoolFromEnvironment(
      process.env,
      opts.databaseUrlEnv,
    );
    try {
      console.log(
        JSON.stringify(
          await applyRegistryMigrations(pool, {
            runtimeRole: process.env.PITLORE_REGISTRY_RUNTIME_ROLE,
          }),
          null,
          2,
        ),
      );
    } finally {
      await pool.end();
    }
  });

registry
  .command("reindex-discovery")
  .description(
    "Reverify immutable artifacts and append missing public-discovery metadata",
  )
  .option(
    "--database-url-env <name>",
    "environment variable containing the migration-owner PostgreSQL URL",
    "PITLORE_REGISTRY_DATABASE_URL",
  )
  .option(
    "--use-split-migration-owner-env",
    "explicitly use split Registry database environment values (Compose); the connected role is still verified",
  )
  .option(
    "--max-releases <count>",
    "maximum releases to process in this bounded run",
    "1000",
  )
  .action(async (opts: {
    databaseUrlEnv: string;
    useSplitMigrationOwnerEnv: boolean;
    maxReleases: string;
  }) => {
    const maxReleases = parseDiscoveryReindexLimit(opts.maxReleases);
    const pool = opts.useSplitMigrationOwnerEnv
      ? createRegistryPostgresPoolFromEnvironment(
          process.env,
          opts.databaseUrlEnv,
        )
      : createRegistryPostgresPoolFromRequiredUrlEnvironment(
          process.env,
          opts.databaseUrlEnv,
        );
    try {
      console.log(
        JSON.stringify(
          await reindexRegistryReleaseDiscovery(pool, {
            maxReleases,
          }),
          null,
          2,
        ),
      );
    } finally {
      await pool.end();
    }
  });

registry
  .command("bootstrap")
  .description(
    "Idempotently bind one external identity as the first organization owner",
  )
  .requiredOption("--subject <subject>", "external OIDC subject claim")
  .requiredOption("--display-name <name>", "owner display name")
  .requiredOption("--org-slug <slug>", "organization namespace slug")
  .requiredOption("--org-name <name>", "organization display name")
  .option("--provider <id>", "OIDC provider id (or PITLORE_OIDC_PROVIDER)")
  .option("--issuer <url>", "exact OIDC issuer (or PITLORE_OIDC_ISSUER)")
  .option(
    "--database-url-env <name>",
    "environment variable containing the PostgreSQL URL",
    "PITLORE_REGISTRY_DATABASE_URL",
  )
  .action(
    async (opts: {
      subject: string;
      displayName: string;
      orgSlug: string;
      orgName: string;
      provider?: string;
      issuer?: string;
      databaseUrlEnv: string;
    }) => {
      const provider =
        opts.provider?.trim() || process.env.PITLORE_OIDC_PROVIDER?.trim();
      if (!provider) {
        throw new Error(
          "OIDC provider is required via --provider or PITLORE_OIDC_PROVIDER",
        );
      }
      const identityIssuer =
        opts.issuer?.trim() || process.env.PITLORE_OIDC_ISSUER?.trim();
      if (!identityIssuer) {
        throw new Error(
          "OIDC issuer is required via --issuer or PITLORE_OIDC_ISSUER",
        );
      }
      const pool = createRegistryPostgresPoolFromEnvironment(
        process.env,
        opts.databaseUrlEnv,
      );
      try {
        console.log(
          JSON.stringify(
            await bootstrapPostgresRegistry(pool, {
              provider,
              identityIssuer,
              providerSubject: opts.subject,
              displayName: opts.displayName,
              organizationSlug: opts.orgSlug,
              organizationName: opts.orgName,
            }),
            null,
            2,
          ),
        );
      } finally {
        await pool.end();
      }
    },
  );

registry
  .command("bootstrap-token")
  .description(
    "Issue one service-safe owner token through privileged local database access",
  )
  .requiredOption("--subject <subject>", "external OIDC subject claim")
  .requiredOption("--org-slug <slug>", "existing organization namespace slug")
  .requiredOption("--expires-at <timestamp>", "canonical ISO-8601 expiry")
  .option("--provider <id>", "OIDC provider id (or PITLORE_OIDC_PROVIDER)")
  .option("--issuer <url>", "exact OIDC issuer (or PITLORE_OIDC_ISSUER)")
  .option(
    "--scope <permission>",
    "service scope; repeat pack:read or pack:publish",
    collect,
    [],
  )
  .option(
    "--database-url-env <name>",
    "environment variable containing the PostgreSQL URL",
    "PITLORE_REGISTRY_DATABASE_URL",
  )
  .action(
    async (opts: {
      subject: string;
      orgSlug: string;
      expiresAt: string;
      provider?: string;
      issuer?: string;
      scope: string[];
      databaseUrlEnv: string;
    }) => {
      const provider =
        opts.provider?.trim() || process.env.PITLORE_OIDC_PROVIDER?.trim();
      if (!provider) {
        throw new Error(
          "OIDC provider is required via --provider or PITLORE_OIDC_PROVIDER",
        );
      }
      const identityIssuer =
        opts.issuer?.trim() || process.env.PITLORE_OIDC_ISSUER?.trim();
      if (!identityIssuer) {
        throw new Error(
          "OIDC issuer is required via --issuer or PITLORE_OIDC_ISSUER",
        );
      }
      const scopes =
        opts.scope.length > 0 ? opts.scope : ["pack:read", "pack:publish"];
      const pool = createRegistryPostgresPoolFromEnvironment(
        process.env,
        opts.databaseUrlEnv,
      );
      try {
        const issued = await issuePostgresBootstrapToken(pool, {
          provider,
          identityIssuer,
          providerSubject: opts.subject,
          organizationSlug: opts.orgSlug,
          scopes: scopes as ("pack:read" | "pack:publish")[],
          expiresAt: opts.expiresAt,
        });
        console.log(
          JSON.stringify(
            {
              token: issued.token,
              token_id: issued.tokenId,
              organization_id: issued.organizationId,
              subject_id: issued.subjectId,
              prefix: issued.prefix,
              scopes: issued.scopes,
              expires_at: issued.expiresAt,
            },
            null,
            2,
          ),
        );
        console.error(
          "Store this token now; PitLore persists only its SHA-256 digest.",
        );
      } finally {
        await pool.end();
      }
    },
  );

registry
  .command("serve")
  .description("Run the durable self-hosted Registry and Web application")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option(
    "--database-url-env <name>",
    "environment variable containing the PostgreSQL URL",
    "PITLORE_REGISTRY_DATABASE_URL",
  )
  .action(
    async (opts: { host: string; port: string; databaseUrlEnv: string }) => {
      const port = parsePort(opts.port);
      const host = parseHost(opts.host);
      const oidc = loadRegistryOidcEnvironment();
      const billing = loadRegistryBillingEnvironment();
      const browserAuth = loadRegistryBrowserAuthEnvironment();
      const trustProxy = loadRegistryTrustProxyEnvironment();
      if (browserAuth && !oidc) {
        throw new Error(
          "PITLORE_BROWSER_AUTH_* requires the PITLORE_OIDC_* identity verifier to be configured",
        );
      }
      const pool = createRegistryPostgresPoolFromEnvironment(
        process.env,
        opts.databaseUrlEnv,
      );
      const runtime = await createPostgresRegistryRuntime({
        pool,
        closePool: true,
        identity: oidc ?? undefined,
        browserAuth: browserAuth ?? undefined,
        trustProxy,
        ...billing,
      });
      try {
        await runtime.app.listen({ host, port });
        console.error(
          `PitLore Registry listening on http://${formatHostForUrl(host)}:${port}`,
        );
        if (!oidc) {
          console.error(
            "OIDC is not configured; only previously issued service tokens and public reads are available.",
          );
        }
        if (browserAuth) {
          console.error(
            "Browser login enabled at /auth/login (engineering baseline; verify against your real IdP before relying on it).",
          );
        }
        await waitForShutdownSignal();
      } finally {
        await runtime.close();
      }
    },
  );

program
  .command("serve")
  .description("Start MCP server on stdio (for Codex / Claude / Cursor)")
  .option("--lore <path>", "lore root override")
  .action(async (opts: { lore?: string }) => {
    if (opts.lore) process.env.PITLORE_LORE = path.resolve(opts.lore);
    console.error(`PitLore MCP serving lore: ${resolveLoreRoot()}`);
    await startMcpServer(opts.lore ? path.resolve(opts.lore) : undefined);
  });

program
  .command("path")
  .description("Print resolved lore root")
  .action(() => {
    console.log(resolveLoreRoot());
  });

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readJsonInput(
  filename: string,
  label: string,
): Promise<unknown> {
  const raw =
    filename === "-" ? await readStdin() : fs.readFileSync(filename, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFixSignal(
  input: FixSignal | unknown,
  dryRun: boolean,
  useOpenAi: boolean,
) {
  const distiller = useOpenAi ? distillLesson : undefined;
  if (dryRun) {
    console.log(
      JSON.stringify(await distillFixSignal(input, distiller), null, 2),
    );
    return;
  }
  const result = await ingestFixSignal(writableLoreRoot(), input, distiller);
  console.log(
    result.created
      ? `Saved private candidate lesson ${result.lesson.id}`
      : `Fix signal already mapped to ${result.lesson.status} lesson ${result.lesson.id}`,
  );
  if (result.file) console.log(result.file);
  console.log("Candidate remains unapproved. Human review is still required.");
}

function writableLoreRoot(): string {
  return ensureWritableLoreRoot(undefined, {
    onCreate: (root) => console.error(`Created writable lore at ${root}`),
  });
}

function registryClient(
  options: { url?: string; tokenEnv?: string },
  authenticated: boolean | "optional" = false,
): RegistryHttpClient {
  const baseUrl =
    options.url?.trim() || process.env.PITLORE_REGISTRY_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Registry URL is required via --url or PITLORE_REGISTRY_URL",
    );
  }
  let bearerToken: string | undefined;
  if (authenticated !== false) {
    const variable = options.tokenEnv ?? "PITLORE_REGISTRY_TOKEN";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw new Error("--token-env must name a valid environment variable");
    }
    bearerToken = process.env[variable] || undefined;
    if (authenticated === true && !bearerToken) {
      throw new Error(`Registry bearer token is required in ${variable}`);
    }
  }
  return new RegistryHttpClient({ baseUrl, bearerToken });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Registry port must be an integer between 1 and 65535");
  }
  return port;
}

function parseDiscoveryReindexLimit(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      "Registry discovery reindex max releases must be an integer between 1 and 100000",
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > 100_000) {
    throw new Error(
      "Registry discovery reindex max releases must be an integer between 1 and 100000",
    );
  }
  return count;
}

function parseHost(value: string): string {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9.:-]+$/.test(value)
  ) {
    throw new Error("Registry host must be a bounded hostname or IP address");
  }
  return value;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
