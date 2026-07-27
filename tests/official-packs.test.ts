import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPack } from "../src/pack.js";

const packsRoot = path.resolve("packs");
const repositoryLicense = fs.readFileSync(path.resolve("LICENSE"), "utf8");

function discoverOfficialPacks(): string[] {
  const entries = fs.readdirSync(packsRoot, { withFileTypes: true });
  const unsupported = entries.filter(
    (entry) => !entry.isDirectory() || entry.isSymbolicLink(),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `packs/ may contain only real Pack directories: ${unsupported
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }
  return entries.map((entry) => entry.name).sort();
}

describe("official Phase 2 Packs", () => {
  it("ships three disjoint, policy-valid public Packs", () => {
    const officialPacks = discoverOfficialPacks();
    expect(officialPacks.length).toBeGreaterThanOrEqual(3);
    expect(officialPacks.length).toBeLessThanOrEqual(5);
    const lessonIds = new Set<string>();
    for (const directory of officialPacks) {
      const pack = verifyPack(path.join(packsRoot, directory));
      expect(pack.store.manifest.name).toBe(`pitlore/${directory}`);
      expect(pack.store.manifest.visibility).toBe("public");
      expect(pack.files).toContain("LICENSE");
      expect(
        fs.readFileSync(path.join(pack.root, "LICENSE"), "utf8"),
      ).toBe(repositoryLicense);
      expect(pack.signature.status).toBe("unverified");
      expect(pack.integrity).toMatch(/^sha256-/);
      for (const lesson of pack.store.lessons) {
        expect(lessonIds.has(lesson.id)).toBe(false);
        lessonIds.add(lesson.id);
      }
    }
    expect(lessonIds.size).toBe(12);
  });
});
