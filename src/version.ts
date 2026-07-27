import { createRequire } from "node:module";

const manifest: unknown = createRequire(import.meta.url)("../package.json");
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string" ||
  manifest.version.trim().length === 0
) {
  throw new Error("package.json must declare a non-empty version");
}

export const PACKAGE_VERSION = manifest.version;
