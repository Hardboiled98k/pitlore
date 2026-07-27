import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLesson } from "../src/schema.js";
import {
  approveLesson,
  initLore,
  loadStore,
  putLesson,
} from "../src/store.js";
import { pitloreCliArgs, pitloreCliCommand } from "./cli-test-command.js";
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("pitlore init", () => {
  it("initializes a custom team lore root", () => {
    const cwd = makeTempRoot();
    const teamLore = path.join(cwd, "team-lore");
    const output = execFileSync(
      pitloreCliCommand,
      pitloreCliArgs(
        "init",
        "--path",
        teamLore,
        "--no-seed",
        "--name",
        "demo/team",
      ),
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PITLORE_LORE: "" },
      },
    );

    const store = loadStore(teamLore);
    expect(output).toContain(`Initialized PitLore at ${teamLore}`);
    expect(store.manifest.name).toBe("demo/team");
    expect(store.lessons).toEqual([]);
  });

  it("rejects conflicting init destinations", () => {
    const cwd = makeTempRoot();
    const result = spawnSync(
      pitloreCliCommand,
      pitloreCliArgs(
        "init",
        "--home",
        "--path",
        path.join(cwd, "team-lore"),
      ),
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PITLORE_LORE: "" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--home and --path cannot be used together");
  });
});

describe("pitlore retrieve", () => {
  it.each([
    {
      name: "repeatable --file",
      args: ["--file", "src/a.ts", "--file", "src/b.ts"],
      expected: ["retrieve-file-alias-a", "retrieve-file-alias-b"],
    },
    {
      name: "plural --files",
      args: ["--files", "src/a.ts", "src/b.ts"],
      expected: ["retrieve-file-alias-a", "retrieve-file-alias-b"],
    },
    {
      name: "mixed --file and --files",
      args: ["--file", "src/a.ts", "--files", "src/b.ts"],
      expected: ["retrieve-file-alias-a", "retrieve-file-alias-b"],
    },
    {
      name: "literal comma path",
      args: ["--files", "src/a,b.ts"],
      expected: ["retrieve-file-alias-comma"],
    },
  ])(
    "accepts $name without changing path semantics",
    ({ args, expected }) => {
      const { retrieveIds } = makeRetrieveFixture();
      expect(retrieveIds(args)).toEqual(expected);
    },
    // Each case spawns one dev-CLI subprocess; loaded Windows CI runners have
    // exceeded the 5s default on cold tsx startup (PR run 29598600310).
    15_000,
  );

  it("preserves an empty canonical --file value", () => {
    const { retrieveIds } = makeRetrieveFixture();
    expect(retrieveIds(["--file", ""], false)).toEqual([]);
  });
});

function makeRetrieveFixture(): {
  retrieveIds: (args: string[], includeIntent?: boolean) => string[];
} {
  const cwd = makeTempRoot();
  const loreRoot = path.join(cwd, "lore");
  initLore(loreRoot, { copySeed: false });
  for (const [id, scopedPath] of [
    ["retrieve-file-alias-a", "src/a.ts"],
    ["retrieve-file-alias-b", "src/b.ts"],
    ["retrieve-file-alias-comma", "src/a,b.ts"],
  ] as const) {
    putLesson(
      loreRoot,
      validateLesson({
        id,
        title: `Retrieve file alias ${id}`,
        languages: ["typescript"],
        category: "cli",
        symptom: "A relevant scoped lesson was omitted from retrieval",
        root_cause: "The CLI did not normalize the supported file option forms",
        forbid_pattern_abstract: "Assume only one spelling of a repeatable file option",
        safe_pattern_abstract: "Normalize singular and plural file option forms",
        scope: { paths: [scopedPath] },
        severity: "warn",
        status: "candidate",
        visibility: "private",
      }),
    );
    approveLesson(loreRoot, id);
  }
  putLesson(
    loreRoot,
    validateLesson({
      id: "retrieve-file-alias-unscoped",
      title: "Unscoped default retrieval sentinel",
      languages: ["typescript"],
      category: "cli",
      symptom: "An empty canonical file value lost its semantic-context behavior",
      root_cause: "Compatibility normalization filtered an existing option value",
      forbid_pattern_abstract: "Filter values accepted by the canonical option",
      safe_pattern_abstract: "Preserve canonical option values byte for byte",
      severity: "warn",
      status: "candidate",
      visibility: "private",
    }),
  );
  approveLesson(loreRoot, "retrieve-file-alias-unscoped");

  return {
    retrieveIds: (args, includeIntent = true) => {
      const output = execFileSync(
        pitloreCliCommand,
        pitloreCliArgs(
          "retrieve",
          ...(includeIntent
            ? ["--intent", "retrieve scoped lessons for changed files"]
            : []),
          ...args,
          "--json",
        ),
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, PITLORE_LORE: loreRoot },
        },
      );
      return (JSON.parse(output) as Array<{ lesson: { id: string } }>)
        .map((item) => item.lesson.id)
        .sort();
    },
  };
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-cli-init-"));
  tempRoots.push(root);
  return root;
}
