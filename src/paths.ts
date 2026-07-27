import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Package root (repo root when developing from source/dist). */
export function packageRoot(): string {
  // dist/ -> .. ; src via tsx still resolves relative to file
  const candidates = [
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../.."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return c;
  }
  return path.resolve(__dirname, "..");
}

export function seedDir(): string {
  return path.join(packageRoot(), "seed");
}

export function homePitloreDir(): string {
  return path.join(os.homedir(), ".pitlore");
}

export function resolveLoreRoot(cwd = process.cwd()): string {
  const fromEnv = process.env.PITLORE_LORE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);

  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".pitlore");
    if (fs.existsSync(path.join(candidate, "manifest.yaml"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const home = path.join(homePitloreDir(), "lore");
  if (fs.existsSync(path.join(home, "manifest.yaml"))) return home;

  // Fall back to bundled seed as read-only default lore
  return seedDir();
}

export function defaultProjectLore(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), ".pitlore");
}
