import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("self-host operator artifact hygiene", () => {
  it("keeps one-time bearer exports and database dumps out of Git and Docker contexts", () => {
    for (const filename of [".gitignore", ".dockerignore"]) {
      const patterns = new Set(
        fs
          .readFileSync(fileURLToPath(new URL(`../${filename}`, import.meta.url)), "utf8")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      for (const pattern of [
        "operator-artifacts" + (filename === ".gitignore" ? "/" : ""),
        "bootstrap-token*.json",
        "*.dump",
        "*.dump.sha256",
      ]) {
        expect(patterns.has(pattern), `${filename} must ignore ${pattern}`).toBe(true);
      }
    }
  });

  it("does not copy operator artifacts into the temporary smoke build context", () => {
    const smoke = fs.readFileSync(
      fileURLToPath(new URL("../scripts/self-host-smoke.sh", import.meta.url)),
      "utf8",
    );
    for (const pattern of [
      "./operator-artifacts",
      "bootstrap-token*.json",
      "*.dump",
      "*.dump.sha256",
    ]) {
      expect(smoke).toContain(`--exclude='${pattern}'`);
    }
  });

  it("keeps the host secret directory private while supporting non-root Compose readers", () => {
    const smoke = fs.readFileSync(
      fileURLToPath(new URL("../scripts/self-host-smoke.sh", import.meta.url)),
      "utf8",
    );
    expect(smoke).toContain('chmod 700 "$directory"');
    expect(smoke).toContain(
      'chmod 644 "$directory/postgres-$name-password"',
    );

    const compose = fs.readFileSync(
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "utf8",
    );
    expect(compose).toContain(
      '["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "pitlore_admin", "-d", "pitlore"]',
    );
  });

  it("wires the complete optional browser-auth group through Compose", () => {
    const compose = fs.readFileSync(
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "utf8",
    );
    const example = fs.readFileSync(
      fileURLToPath(new URL("../.env.example", import.meta.url)),
      "utf8",
    );
    for (const name of [
      "PITLORE_BROWSER_AUTH_AUTHORIZE_URL",
      "PITLORE_BROWSER_AUTH_TOKEN_URL",
      "PITLORE_BROWSER_AUTH_CLIENT_ID",
      "PITLORE_BROWSER_AUTH_REDIRECT_URI",
    ]) {
      expect(compose).toContain(`${name}: \${${name}:-}`);
      expect(example).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});
