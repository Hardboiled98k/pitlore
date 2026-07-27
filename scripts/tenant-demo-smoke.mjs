import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = path.join(projectRoot, "dist", "cli.js");
const templateRoot = path.join(projectRoot, "demo", "tenant-isolation", "lore");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-demo-"));
const loreRoot = path.join(temporaryRoot, "lore");
const badFixture = path.join(templateRoot, "fixtures", "bad", "tenant-missing.ts");
const goodFixture = path.join(templateRoot, "fixtures", "good", "tenant-scoped.ts");
const lessonId = "tenant-query-requires-tenant-id";
const env = { ...process.env, OPENAI_API_KEY: "", PITLORE_LORE: loreRoot };

function run(args, expectedStatus, expectedText) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== expectedStatus || !output.includes(expectedText)) {
    throw new Error(
      `Demo command failed: pitlore ${args.join(" ")}\n` +
        `expected status ${expectedStatus} and text ${JSON.stringify(expectedText)}\n` +
        `received status ${result.status}\n${output}`,
    );
  }
}

try {
  fs.cpSync(templateRoot, loreRoot, { recursive: true });

  run(
    [
      "retrieve",
      "-i",
      "review a multi-tenant project query for missing tenantId",
      "-f",
      badFixture,
      "-l",
      "typescript",
    ],
    0,
    "No PitLore lessons matched this context.",
  );
  run(["check", "--all", badFixture], 2, lessonId);
  run(["check", "--all", goodFixture], 0, "No PitLore findings.");
  run(["approve", lessonId], 0, `Approved ${lessonId}`);
  run(
    [
      "retrieve",
      "-i",
      "review a multi-tenant project query for missing tenantId",
      "-f",
      badFixture,
      "-l",
      "typescript",
    ],
    0,
    lessonId,
  );
  run(["check", badFixture], 2, lessonId);
  run(["check", goodFixture], 0, "No PitLore findings.");

  console.log("Tenant isolation demo passed: candidate -> approve -> retrieve/check");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
