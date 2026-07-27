import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import semver from "semver";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const external = Object.keys(packageJson.dependencies ?? {}).flatMap((name) => [
  name,
  `${name}/*`,
]);

const result = await build({
  entryPoints: [path.join(projectRoot, "src", "mcp-runtime.ts")],
  outfile: path.join(projectRoot, "dist", "mcp-runtime.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  logLevel: "info",
});

const bundledInputs = Object.keys(result.metafile.inputs);
const bundledPackageRoots = new Map();
for (const input of bundledInputs) {
  const normalized = input.replaceAll("\\", "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker === -1) continue;
  const segments = normalized.slice(marker + "node_modules/".length).split("/");
  const name = segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const relativeRoot = normalized.slice(
    0,
    marker + "node_modules/".length + name.length,
  );
  const roots = bundledPackageRoots.get(name) ?? new Set();
  roots.add(path.resolve(projectRoot, relativeRoot));
  bundledPackageRoots.set(name, roots);
}
const licensedPackages = new Map([
  ["@modelcontextprotocol/sdk", "1.29.0"],
  ["ajv", "8.20.0"],
  ["ajv-formats", "3.0.1"],
  ["fast-deep-equal", "3.1.3"],
  ["fast-uri", "3.1.4"],
  ["json-schema-traverse", "1.0.0"],
  ["zod-to-json-schema", "3.25.2"],
]);
const bundledPackages = new Set(bundledPackageRoots.keys());
const missingNotices = [...bundledPackages].filter(
  (name) => !licensedPackages.has(name),
);
const staleNotices = [...licensedPackages.keys()].filter(
  (name) => !bundledPackages.has(name),
);
if (missingNotices.length > 0 || staleNotices.length > 0) {
  throw new Error(
    `Bundled dependency notices are out of date (missing: ${missingNotices.join(
      ", ",
    ) || "none"}; stale: ${staleNotices.join(", ") || "none"})`,
  );
}
const notices = fs.readFileSync(
  path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);
for (const [name, expectedVersion] of licensedPackages) {
  for (const packageRoot of bundledPackageRoots.get(name)) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `Bundled ${name} version ${manifest.version} does not match licensed ${expectedVersion}`,
      );
    }
  }
  if (!notices.includes(`## ${name} ${expectedVersion} —`)) {
    throw new Error(`Third-party notice heading is missing for ${name}`);
  }
}
if (
  !bundledInputs.some((input) =>
    input.includes("node_modules/@modelcontextprotocol/sdk/"),
  )
) {
  throw new Error("MCP SDK was not bundled into the runtime facade");
}
if (
  bundledInputs.some((input) =>
    input.includes("node_modules/@hono/node-server/"),
  )
) {
  throw new Error("Unused Hono HTTP adapter leaked into the MCP stdio bundle");
}

for (const packageRoot of bundledPackageRoots.get("fast-uri")) {
  const fastUriPackage = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (
    semver.satisfies(
      fastUriPackage.version,
      ">=3.0.0 <=3.1.3 || >=4.0.0 <=4.1.0",
    )
  ) {
    throw new Error(
      `Refusing to bundle vulnerable fast-uri ${fastUriPackage.version}`,
    );
  }
}

const declaredRuntimeDependencies = new Set(
  Object.keys(packageJson.dependencies ?? {}),
);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const externalImports = Object.values(result.metafile.outputs).flatMap(
  (output) => output.imports.filter((item) => item.external),
);
for (const imported of externalImports) {
  const segments = imported.path.split("/");
  const packageName = imported.path.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  if (!builtins.has(imported.path) && !declaredRuntimeDependencies.has(packageName)) {
    throw new Error(`MCP bundle has undeclared runtime import: ${imported.path}`);
  }
}

fs.writeFileSync(
  path.join(projectRoot, "dist", "mcp-runtime.d.ts"),
  "export {};\n",
  "utf8",
);
for (const staleMap of ["mcp-runtime.d.ts.map", "mcp-runtime.js.map"]) {
  fs.rmSync(path.join(projectRoot, "dist", staleMap), { force: true });
}
