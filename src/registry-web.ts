import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

const WEB_ASSETS = {
  index: loadWebAsset("index.html"),
  css: loadWebAsset("app.css"),
  js: loadWebAsset("app.js"),
  icon: loadWebAsset("pitlore-mark.svg"),
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export function registerRegistryWeb(app: FastifyInstance): void {
  app.get("/", async (_request, reply) =>
    webReply(reply, "text/html; charset=utf-8", WEB_ASSETS.index, true),
  );
  app.get("/app.css", async (_request, reply) =>
    webReply(reply, "text/css; charset=utf-8", WEB_ASSETS.css),
  );
  app.get("/app.js", async (_request, reply) =>
    webReply(reply, "text/javascript; charset=utf-8", WEB_ASSETS.js),
  );
  app.get("/pitlore-mark.svg", async (_request, reply) =>
    webReply(reply, "image/svg+xml; charset=utf-8", WEB_ASSETS.icon),
  );
}

function webReply(
  reply: FastifyReply,
  contentType: string,
  content: Buffer,
  html = false,
): FastifyReply {
  reply.header("cache-control", "no-cache");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  if (html) reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
  return reply.type(contentType).send(content);
}

function loadWebAsset(name: string): Buffer {
  const assetPath = fileURLToPath(new URL(`../web/${name}`, import.meta.url));
  const expected = fs.lstatSync(assetPath);
  if (expected.isSymbolicLink() || !expected.isFile()) {
    throw new Error(`Registry Web asset must be a regular file: ${name}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(assetPath, fs.constants.O_RDONLY | noFollow);
    const current = fs.fstatSync(descriptor);
    if (
      !current.isFile() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`Registry Web asset changed during read: ${name}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
