/**
 * Browser login for the self-hosted Registry Web UI: OIDC authorization-code
 * flow with PKCE (S256), a server-side single-use state store, a bounded token
 * exchange, ID-token verification through the existing IdentityVerifier, and
 * an HttpOnly session cookie. Browser sessions are an authentication bridge,
 * not an authorization cache: every use resolves the verified external
 * identity back to one current active local membership and role.
 *
 * Honest boundaries: pending logins and sessions live in per-process memory,
 * so they do not survive restarts and do not replicate across instances; this
 * flow has only been exercised against local mock IdPs, which is engineering
 * verification, not real IdP onboarding evidence.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  HumanActor,
  IdentityVerifier,
  VerifiedIdentity,
} from "./registry-auth.js";

const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
const SESSION_COOKIE = "__Host-pitlore_session";
const CSRF_COOKIE = "__Host-pitlore_csrf";
const LOGIN_COOKIE = "__Host-pitlore_login";
const LOGIN_NONCE = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;
const MAX_ID_TOKEN_LENGTH = 32_768;
const MAX_CALLBACK_CODE_LENGTH = 2_048;

type MaybePromise<T> = T | Promise<T>;

export interface BrowserSessionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly provider: string;
  readonly issuer: string;
  readonly subjectId: string;
  readonly providerSubjectId: string;
  readonly identityVerifiedAt: string;
  readonly csrfHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BrowserSessionStore {
  create(record: BrowserSessionRecord): MaybePromise<void>;
  get(id: string): MaybePromise<BrowserSessionRecord | null>;
  delete(id: string): MaybePromise<void>;
}

/** Per-process bounded session store; not durable and not multi-instance. */
export class InMemoryBrowserSessionStore implements BrowserSessionStore {
  readonly #sessions = new Map<string, BrowserSessionRecord>();

  create(record: BrowserSessionRecord): void {
    this.#sessions.set(record.id, record);
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done || oldest.value === record.id) break;
      this.#sessions.delete(oldest.value);
    }
  }

  get(id: string): BrowserSessionRecord | null {
    return this.#sessions.get(id) ?? null;
  }

  delete(id: string): void {
    this.#sessions.delete(id);
  }
}

export interface BrowserLoginOptions {
  provider: string;
  verifier: IdentityVerifier;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** Resolve this exact verified identity to its current local actor. */
  resolveActor: BrowserIdentityActorResolver;
  sessions?: BrowserSessionStore;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export type BrowserIdentityActorResolver = (
  identity: VerifiedIdentity,
) => MaybePromise<HumanActor | null>;

export interface BrowserSessionAuthenticator {
  /** Returns the current local actor, never a role cached in the session. */
  authenticate(
    request: FastifyRequest,
    reply?: FastifyReply,
  ): Promise<HumanActor | null>;
}

export class BrowserSessionCsrfError extends Error {
  constructor() {
    super("Browser session CSRF validation failed");
    this.name = "BrowserSessionCsrfError";
  }
}

interface PendingLogin {
  readonly codeVerifier: string;
  readonly oidcNonce: string;
  readonly loginNonceHash: string;
  readonly orgId: string;
  readonly createdAtMs: number;
}

const LoginQuerySchema = z
  .object({ org_id: z.string().uuid() })
  .strict();

const CallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(MAX_CALLBACK_CODE_LENGTH).optional(),
    state: z.string().min(1).max(256).optional(),
    error: z.string().max(256).optional(),
    error_description: z.string().max(1_024).optional(),
  })
  .strict();

const TokenResponseSchema = z
  .object({ id_token: z.string().min(1).max(MAX_ID_TOKEN_LENGTH) })
  .passthrough();

export function registerBrowserAuth(
  app: FastifyInstance,
  options: BrowserLoginOptions,
): BrowserSessionAuthenticator {
  if (typeof options.provider !== "string" || options.provider.length === 0) {
    throw new Error("Browser login provider must be configured");
  }
  if (!CLIENT_ID.test(options.clientId)) {
    throw new Error("Browser login clientId must be a bounded printable string");
  }
  const authorizationEndpoint = requireCredentialFreeHttpsUrl(
    options.authorizationEndpoint,
    "Browser login authorization endpoint",
  );
  const tokenEndpoint = requireCredentialFreeHttpsUrl(
    options.tokenEndpoint,
    "Browser login token endpoint",
  );
  const redirectUri = requireCredentialFreeHttpsUrl(
    options.redirectUri,
    "Browser login redirect URI",
  );
  if (typeof options.resolveActor !== "function") {
    throw new Error("Browser login actor resolver must be configured");
  }
  const expectedOrigin = new URL(redirectUri).origin;
  const sessions = options.sessions ?? new InMemoryBrowserSessionStore();
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const pending = new Map<string, PendingLogin>();

  const prunePending = (nowMs: number): void => {
    for (const [state, login] of pending) {
      if (nowMs - login.createdAtMs > PENDING_LOGIN_TTL_MS) pending.delete(state);
    }
    while (pending.size > MAX_PENDING_LOGINS) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
  };

  app.get("/auth/login", async (request, reply) => {
    const query = LoginQuerySchema.parse(request.query);
    const nowMs = clock().getTime();
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const oidcNonce = randomBytes(32).toString("base64url");
    const loginNonce = randomBytes(32).toString("base64url");
    pending.set(state, {
      codeVerifier,
      oidcNonce,
      loginNonceHash: hashOpaqueValue(loginNonce),
      orgId: query.org_id,
      createdAtMs: nowMs,
    });
    prunePending(nowMs);

    const location = new URL(authorizationEndpoint);
    location.searchParams.set("response_type", "code");
    location.searchParams.set("client_id", options.clientId);
    location.searchParams.set("redirect_uri", redirectUri);
    location.searchParams.set("scope", "openid");
    location.searchParams.set("state", state);
    location.searchParams.set("nonce", oidcNonce);
    location.searchParams.set("code_challenge", s256Challenge(codeVerifier));
    location.searchParams.set("code_challenge_method", "S256");
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", loginCookie(loginNonce, PENDING_LOGIN_TTL_MS));
    return reply.code(302).header("location", location.toString()).send();
  });

  app.get("/auth/callback", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", clearLoginCookie());
    const query = CallbackQuerySchema.parse(request.query);
    if (query.error !== undefined) {
      // An IdP error is still a callback attempt. Consume its state so the
      // original authorization response cannot be replayed later.
      if (query.state) pending.delete(query.state);
      // Never echo IdP-controlled error text back into the page.
      return sendAuthError(reply, 400, "idp_denied", "Identity provider rejected the login");
    }
    if (!query.code || !query.state) {
      return sendAuthError(reply, 400, "invalid_callback", "Missing code or state");
    }
    const nowMs = clock().getTime();
    const login = pending.get(query.state);
    // Single use: a state is consumed by its first callback, valid or not.
    if (login) pending.delete(query.state);
    if (!login || nowMs - login.createdAtMs > PENDING_LOGIN_TTL_MS) {
      return sendAuthError(reply, 400, "invalid_state", "Login state is unknown or expired");
    }
    const loginNonce = readLoginNonceCookie(request);
    if (
      !loginNonce ||
      !hashesEqual(login.loginNonceHash, hashOpaqueValue(loginNonce))
    ) {
      return sendAuthError(reply, 400, "invalid_state", "Login state is unknown or expired");
    }

    const idToken = await exchangeAuthorizationCode(
      fetchImpl,
      tokenEndpoint,
      {
        grant_type: "authorization_code",
        code: query.code,
        redirect_uri: redirectUri,
        client_id: options.clientId,
        code_verifier: login.codeVerifier,
      },
    );
    if (idToken === null) {
      return sendAuthError(reply, 502, "idp_exchange_failed", "Token exchange with the identity provider failed");
    }

    const identity = await options.verifier.verify({
      provider: options.provider,
      assertion: idToken,
      expectedTenantId: login.orgId,
      expectedNonce: login.oidcNonce,
    });
    if (!identity) {
      return sendAuthError(reply, 401, "identity_rejected", "Identity token was rejected");
    }

    const actor = await resolveCurrentActor(options.resolveActor, identity);
    if (!actor) {
      return sendAuthError(
        reply,
        403,
        "membership_required",
        "An active organization membership is required",
      );
    }

    const csrfToken = randomBytes(32).toString("base64url");
    const record = createSessionRecord(
      identity,
      login.orgId,
      csrfToken,
      clock(),
    );
    await sessions.create(record);
    reply.header(
      "set-cookie",
      [
        sessionCookie(record.id, SESSION_TTL_MS),
        csrfCookie(csrfToken, SESSION_TTL_MS),
        clearLoginCookie(),
      ],
    );
    return reply.code(303).header("location", "/").send();
  });

  app.get("/auth/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const record = await readActiveSession(request, sessions, clock());
    if (!record) {
      if (readSessionCookie(request) || readCsrfCookie(request)) {
        reply.header("set-cookie", clearSessionCookies());
      }
      return reply.code(200).send({ authenticated: false });
    }
    const actor = await resolveSessionActor(record, options.resolveActor);
    if (!actor) {
      await sessions.delete(record.id);
      reply.header("set-cookie", clearSessionCookies());
      return reply.code(200).send({ authenticated: false });
    }
    return reply.code(200).send({
      authenticated: true,
      org_id: actor.tenantId,
      subject_id: actor.subjectId,
      role: actor.role,
      provider: actor.identityProvider,
      expires_at: record.expiresAt,
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const record = await readActiveSession(request, sessions, clock());
    if (record) {
      assertBrowserCsrf(request, record, expectedOrigin);
      await sessions.delete(record.id);
    }
    reply.header("set-cookie", clearSessionCookies());
    return reply.code(204).send();
  });

  return Object.freeze({
    async authenticate(
      request: FastifyRequest,
      reply?: FastifyReply,
    ): Promise<HumanActor | null> {
      const hadBrowserCookie = Boolean(
        readSessionCookie(request) || readCsrfCookie(request),
      );
      const record = await readActiveSession(request, sessions, clock());
      if (!record) {
        if (hadBrowserCookie) clearSessionCookiesOnResponse(reply);
        return null;
      }
      const actor = await resolveSessionActor(record, options.resolveActor);
      if (!actor) {
        await sessions.delete(record.id);
        clearSessionCookiesOnResponse(reply);
        return null;
      }
      if (!isSafeMethod(request.method)) {
        assertBrowserCsrf(request, record, expectedOrigin);
      }
      return actor;
    },
  });
}

async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  tokenEndpoint: string,
  parameters: Record<string, string>,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  try {
    if (response.status !== 200) return null;
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_TOKEN_RESPONSE_BYTES
    ) {
      return null;
    }
    const text = await readBoundedBody(response, MAX_TOKEN_RESPONSE_BYTES);
    if (text === null) return null;
    const parsed = TokenResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return parsed.data.id_token;
  } catch {
    return null;
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createSessionRecord(
  identity: VerifiedIdentity,
  orgId: string,
  csrfToken: string,
  now: Date,
): BrowserSessionRecord {
  if (identity.tenantId !== orgId) {
    throw new Error("Browser identity tenant does not match the login tenant");
  }
  return Object.freeze({
    id: randomBytes(32).toString("base64url"),
    orgId,
    provider: identity.provider,
    issuer: identity.issuer,
    subjectId: identity.subjectId,
    providerSubjectId: identity.providerSubjectId,
    identityVerifiedAt: identity.verifiedAt,
    csrfHash: hashOpaqueValue(csrfToken),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });
}

async function resolveSessionActor(
  record: BrowserSessionRecord,
  resolver: BrowserIdentityActorResolver,
): Promise<HumanActor | null> {
  return resolveCurrentActor(resolver, {
    provider: record.provider,
    issuer: record.issuer,
    providerSubjectId: record.providerSubjectId,
    subjectId: record.subjectId,
    tenantId: record.orgId,
    verifiedAt: record.identityVerifiedAt,
  });
}

async function resolveCurrentActor(
  resolver: BrowserIdentityActorResolver,
  identity: VerifiedIdentity,
): Promise<HumanActor | null> {
  const actor = await resolver(identity);
  if (
    !actor ||
    actor.kind !== "human" ||
    actor.tenantId !== identity.tenantId ||
    !z.string().uuid().safeParse(actor.subjectId).success ||
    actor.identityProvider !== identity.provider ||
    actor.identityIssuer !== identity.issuer ||
    actor.identityVerifiedAt !== identity.verifiedAt
  ) {
    return null;
  }
  return actor;
}

async function readActiveSession(
  request: FastifyRequest,
  sessions: BrowserSessionStore,
  now: Date,
): Promise<BrowserSessionRecord | null> {
  const sessionId = readSessionCookie(request);
  if (!sessionId) return null;
  const record = await sessions.get(sessionId);
  if (!record) return null;
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    await sessions.delete(sessionId);
    return null;
  }
  return record;
}

function readSessionCookie(request: FastifyRequest): string | null {
  return readCookieValue(request, SESSION_COOKIE, /^[A-Za-z0-9_-]{20,128}$/);
}

function readLoginNonceCookie(request: FastifyRequest): string | null {
  return readCookieValue(request, LOGIN_COOKIE, LOGIN_NONCE);
}

function readCsrfCookie(request: FastifyRequest): string | null {
  return readCookieValue(request, CSRF_COOKIE, CSRF_TOKEN);
}

function readCookieValue(
  request: FastifyRequest,
  name: string,
  pattern: RegExp,
): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0 || header.length > 8_192) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (pattern.test(value)) return value;
    return null;
  }
  return null;
}

function loginCookie(value: string, ttlMs: number): string {
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function clearLoginCookie(): string {
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sessionCookie(value: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function csrfCookie(value: string, ttlMs: number): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function clearSessionCookies(): readonly string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`,
  ];
}

function clearSessionCookiesOnResponse(reply: FastifyReply | undefined): void {
  if (reply && !reply.sent) reply.header("set-cookie", clearSessionCookies());
}

function assertBrowserCsrf(
  request: FastifyRequest,
  record: BrowserSessionRecord,
  expectedOrigin: string,
): void {
  const header = request.headers["x-pitlore-csrf"];
  const csrfToken = typeof header === "string" && CSRF_TOKEN.test(header)
    ? header
    : null;
  if (
    request.headers.origin !== expectedOrigin ||
    !csrfToken ||
    readCsrfCookie(request) !== csrfToken ||
    !hashesEqual(record.csrfHash, hashOpaqueValue(csrfToken))
  ) {
    throw new BrowserSessionCsrfError();
  }
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sendAuthError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}

function s256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

function requireCredentialFreeHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${label} must be a credential-free HTTPS URL without query or fragment`,
    );
  }
  return url.toString();
}
