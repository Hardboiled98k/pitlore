import fs from "node:fs";
import { installPack } from "../../src/pack.js";

const [source, loreRoot, readyPath, startPath] = process.argv.slice(2);
if (!source || !loreRoot || !readyPath || !startPath) {
  throw new Error("Expected source, lore root, ready path, and start path");
}

fs.writeFileSync(readyPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
const deadline = Date.now() + 10_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(startPath)) {
  if (Date.now() >= deadline) throw new Error("Timed out waiting for start barrier");
  Atomics.wait(waitBuffer, 0, 0, 20);
}

installPack(source, { loreRoot });
