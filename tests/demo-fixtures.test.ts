import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkContent } from "../src/check.js";
import { loadStore } from "../src/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "demo", "fixtures");
const store = loadStore(path.join(root, "seed"));

describe("README demo fixtures", () => {
  it.each([
    ["bad-foreach-async.js", "js-foreach-async-await-miss"],
    ["bad-mutable-default.py", "python-mutable-default-arg"],
    ["bad-sql-concat.ts", "sql-string-concat"],
  ])("flags %s with %s", (file, lessonId) => {
    const filePath = path.join(fixtureRoot, file);
    const result = checkContent(store, fs.readFileSync(filePath, "utf8"), {
      filePath,
    });

    expect(result.findings.some((finding) => finding.lessonId === lessonId)).toBe(
      true,
    );
  });

  it("keeps the corrected async fixture clean", () => {
    const filePath = path.join(fixtureRoot, "good-foreach-async.js");
    const result = checkContent(store, fs.readFileSync(filePath, "utf8"), {
      filePath,
    });

    expect(result).toEqual({
      clean: true,
      findings: [],
      configurationErrors: [],
    });
  });
});
