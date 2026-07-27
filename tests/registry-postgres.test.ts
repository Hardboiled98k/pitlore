import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { enablePgMemRlsCompat } from "./helpers/pg-mem-rls.js";
import { describe, expect, it } from "vitest";

describe("Registry PostgreSQL migration", () => {
  it("creates tenant, immutable-release, audit, usage, and billing constraints", async () => {
    const database = newDb();
  enablePgMemRlsCompat(database);
    const adapter = database.adapters.createPg();
    const client = new adapter.Client();
    await client.connect();
    try {
      await client.query(
        fs.readFileSync(
          fileURLToPath(new URL("../migrations/001_registry.sql", import.meta.url)),
          "utf8",
        ),
      );
      await client.query(
        "INSERT INTO registry_users (id, issuer, subject, display_name) VALUES ($1,$2,$3,$4)",
        ["user-a", "test", "subject-a", "User A"],
      );
      await client.query(
        "INSERT INTO registry_organizations (id, slug, name, owner_user_id) VALUES ($1,$2,$3,$4)",
        ["org-a", "org-a", "Org A", "user-a"],
      );
      await client.query(
        "INSERT INTO registry_packages (id, org_id, name, visibility, created_by) VALUES ($1,$2,$3,$4,$5)",
        ["pack-a", "org-a", "org-a/core", "private", "user-a"],
      );
      await client.query(
        "INSERT INTO registry_releases (id, package_id, version, status, artifact_integrity, artifact, manifest, provenance, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          "release-a",
          "pack-a",
          "1.0.0",
          "pending",
          `sha256-${"a".repeat(44)}`,
          {},
          {},
          {},
          "user-a",
        ],
      );
      await expect(
        client.query(
          "INSERT INTO registry_releases (id, package_id, version, status, artifact_integrity, artifact, manifest, provenance, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            "release-b",
            "pack-a",
            "1.0.0",
            "pending",
            `sha256-${"b".repeat(44)}`,
            {},
            {},
            {},
            "user-a",
          ],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          "INSERT INTO registry_memberships (org_id, user_id, role) VALUES ($1,$2,$3)",
          ["org-a", "user-a", "super-admin"],
        ),
      ).rejects.toThrow();
      const tables = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining([
          "registry_api_tokens",
          "registry_audit_events",
          "registry_usage_events",
          "registry_subscriptions",
        ]),
      );
    } finally {
      await client.end();
    }
  });
});
