import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.resolve(projectRoot, "dist");

if (
  path.dirname(distRoot) !== projectRoot ||
  path.basename(distRoot) !== "dist"
) {
  throw new Error(`refusing to clean unexpected output path: ${distRoot}`);
}

fs.rmSync(distRoot, { recursive: true, force: true });
