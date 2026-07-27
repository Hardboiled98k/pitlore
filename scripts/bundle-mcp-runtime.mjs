import crypto from "node:crypto";
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
  [
    "@modelcontextprotocol/sdk",
    {
      version: "1.29.0",
      noticeSha256:
        "62a5fe2f65c55166300bcf53b862a13b49ec8ad25207f889e27d736ef8ecb9a2",
    },
  ],
  [
    "ajv",
    {
      version: "8.20.0",
      noticeSha256:
        "08a91abb6542c5d26395b1a4fa4be973ed114efd1931a79519683c117533d0dd",
    },
  ],
  [
    "ajv-formats",
    {
      version: "3.0.1",
      noticeSha256:
        "ae6a85b16167d95100c666514c6c0e5722b9d7361c892a4568203d3ae2c34087",
    },
  ],
  [
    "fast-deep-equal",
    {
      version: "3.1.3",
      noticeSha256:
        "e5b37df33a552cc525bf686d6abb8061ff8e49d7ec256f65edf5f3338d44f929",
    },
  ],
  [
    "fast-uri",
    {
      version: "3.1.4",
      noticeSha256:
        "a3b18179bc70db1203b99151da5ffe52f6a33b33307a931b4bc7aa469aad562b",
    },
  ],
  [
    "json-schema-traverse",
    {
      version: "1.0.0",
      noticeSha256:
        "e5b37df33a552cc525bf686d6abb8061ff8e49d7ec256f65edf5f3338d44f929",
    },
  ],
  [
    "zod-to-json-schema",
    {
      version: "3.25.2",
      noticeSha256:
        "4bf456ec67f53378a0c99bdbf10bb449e350c2621560097e09256c21588a6db0",
    },
  ],
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
for (const [
  name,
  { version: expectedVersion, noticeSha256 },
] of licensedPackages) {
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
  const heading = `## ${name} ${expectedVersion} —`;
  const headingOffset = notices.indexOf(heading);
  if (headingOffset === -1) {
    throw new Error(`Third-party notice heading is missing for ${name}`);
  }
  const contentStart = notices.indexOf("\n", headingOffset) + 1;
  const nextHeading = notices.indexOf("\n## ", contentStart);
  const content = notices
    .slice(contentStart, nextHeading === -1 ? undefined : nextHeading)
    .replace(/\r\n?/gu, "\n")
    .trim();
  const actualNoticeSha256 = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
  if (actualNoticeSha256 !== noticeSha256) {
    throw new Error(
      `Third-party notice body does not match the reviewed ${name}@${expectedVersion} text`,
    );
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
