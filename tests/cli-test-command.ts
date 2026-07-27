import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tsxEntry = createRequire(import.meta.url).resolve("tsx/cli");
const cliSource = path.join(repoRoot, "src", "cli.ts");

export const pitloreCliCommand = process.execPath;

export function pitloreCliArgs(...args: string[]): string[] {
  return [tsxEntry, cliSource, ...args];
}
