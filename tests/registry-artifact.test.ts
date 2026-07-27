import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RegistryPackArtifactSchema,
  createRegistryPackArtifact,
  materializeRegistryPackArtifact,
  parseRegistryPackArtifact,
  readRegistryPackArtifactFile,
  serializeRegistryPackArtifact,
  withMaterializedRegistryPackArtifact,
  writeRegistryPackArtifactFile,
} from "../src/registry-artifact.js";
import {
  installAirgapPack,
  loadEffectiveStore,
  loadPackLock,
} from "../src/pack.js";
import { initLore } from "../src/store.js";

const OFFICIAL_PACK = fileURLToPath(
  new URL("../packs/node-reliability", import.meta.url),
);

describe("Registry Pack artifact", () => {
  it("round-trips one canonical verified Pack without checksum drift", () => {
    const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
    expect(artifact).toMatchObject({
      format: "pitlore.pack.artifact.v1",
      name: "pitlore/node-reliability",
    });
    expect(artifact.files.map((file) => file.path)).toEqual(
      [...artifact.files.map((file) => file.path)].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    const parsed = parseRegistryPackArtifact(serializeRegistryPackArtifact(artifact));
    const verified = withMaterializedRegistryPackArtifact(parsed, (pack) => ({
      name: pack.store.manifest.name,
      version: pack.store.manifest.version,
      integrity: pack.integrity,
      digestHex: pack.digestHex,
    }));
    expect(verified).toEqual({
      name: artifact.name,
      version: artifact.version,
      integrity: artifact.integrity,
      digestHex: artifact.digest_hex,
    });
  });

  it("rejects content, per-file checksum, and Pack metadata tampering", () => {
    const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
    const first = artifact.files[0];
    if (!first) throw new Error("expected artifact file");
    expect(() =>
      RegistryPackArtifactSchema.parse({
        ...artifact,
        files: [
          { ...first, content_base64: Buffer.from("tampered").toString("base64") },
          ...artifact.files.slice(1),
        ],
      }),
    ).toThrow(/size|checksum/);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-artifact-test-"));
    try {
      expect(() =>
        materializeRegistryPackArtifact(
          { ...artifact, integrity: `sha256-${Buffer.alloc(32, 9).toString("base64")}` },
          path.join(temp, "pack"),
        ),
      ).toThrow(/metadata does not match/);
      expect(fs.existsSync(path.join(temp, "pack"))).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects traversal, Windows absolute paths, duplicates, and non-canonical order", () => {
    const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
    const first = artifact.files[0];
    if (!first) throw new Error("expected artifact file");
    for (const badPath of ["../manifest.yaml", "/manifest.yaml", "C:\\manifest.yaml", "a//b"]) {
      expect(() =>
        RegistryPackArtifactSchema.parse({
          ...artifact,
          files: [{ ...first, path: badPath }, ...artifact.files.slice(1)],
        }),
      ).toThrow(/portable and relative/);
    }
    expect(() =>
      RegistryPackArtifactSchema.parse({ ...artifact, files: [first, first] }),
    ).toThrow(/unique/);
    expect(() =>
      RegistryPackArtifactSchema.parse({ ...artifact, files: [...artifact.files].reverse() }),
    ).toThrow(/canonical path order/);
  });

  it("fails rather than replacing an existing destination", () => {
    const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-artifact-existing-"));
    try {
      expect(() => materializeRegistryPackArtifact(artifact, temp)).toThrow(
        /destination already exists/,
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("writes, reads, and installs a portable artifact with air-gap provenance", () => {
    const artifact = createRegistryPackArtifact(OFFICIAL_PACK);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-airgap-test-"));
    try {
      const filename = path.join(project, "node-reliability.pitlore.json");
      expect(writeRegistryPackArtifactFile(filename, artifact)).toBe(filename);
      expect(readRegistryPackArtifactFile(filename)).toEqual(artifact);
      expect(() => writeRegistryPackArtifactFile(filename, artifact)).toThrow(
        /already exists/,
      );

      const lore = path.join(project, ".pitlore");
      initLore(lore, { name: "test/airgap", copySeed: false });
      const installed = withMaterializedRegistryPackArtifact(artifact, (pack) =>
        installAirgapPack(pack.root, { loreRoot: lore }),
      );
      expect(installed.name).toBe(artifact.name);
      expect(loadPackLock(lore).packages[artifact.name]?.source).toEqual({
        type: "airgap",
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps private Lessons private through Registry artifact and air-gap install", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pitlore-private-airgap-"));
    try {
      const privatePack = path.join(project, "private-pack");
      fs.cpSync(OFFICIAL_PACK, privatePack, { recursive: true });
      for (const relative of [
        "manifest.yaml",
        ...fs.readdirSync(path.join(privatePack, "lessons")).map(
          (name) => `lessons/${name}`,
        ),
      ]) {
        const filename = path.join(privatePack, relative);
        fs.writeFileSync(
          filename,
          fs.readFileSync(filename, "utf8").replace("visibility: public", "visibility: private"),
          "utf8",
        );
      }
      const artifact = createRegistryPackArtifact(privatePack);
      expect(
        withMaterializedRegistryPackArtifact(
          artifact,
          (pack) => pack.store.manifest.visibility,
        ),
      ).toBe("private");

      const lore = path.join(project, ".pitlore");
      initLore(lore, { name: "test/private-airgap", copySeed: false });
      withMaterializedRegistryPackArtifact(artifact, (pack) =>
        installAirgapPack(pack.root, { loreRoot: lore }),
      );
      expect(
        loadEffectiveStore(lore).lessons.every(
          (lesson) => lesson.visibility === "private",
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
