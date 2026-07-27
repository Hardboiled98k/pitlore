import { createHash, generateKeyPair } from "node:crypto";
import {
  SignJWT,
  exportJWK,
  type JWK,
  type JSONWebKeySet,
} from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createHumanActor,
  type HumanActor,
  type VerifiedIdentity,
} from "../src/registry-auth.js";
import { createRegistryServer } from "../src/registry-server.js";
import { OidcJwtIdentityVerifier } from "../src/registry-oidc.js";
import type {
  BrowserIdentityActorResolver,
  BrowserSessionRecord,
  BrowserSessionStore,
} from "../src/registry-browser-auth.js";

const NOW = new Date("2026-07-18T10:00:00.000Z");
const ISSUER = "https://identity.example.com/";
const AUDIENCE = "pitlore-registry";
const TOKEN_ENDPOINT = "https://identity.example.com/oauth/token";
const REGISTRY_ORIGIN = "https://registry.example.com";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const LOCAL_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

beforeAll(async () => {
  const pair = await new Promise<{
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  }>((resolve, reject) => {
    generateKeyPair(
      "rsa",
      { modulusLength: 2048 },
      (error, publicKey, generatedPrivateKey) => {
        if (error) reject(error);
        else
          resolve({
            publicKey: publicKey as unknown as CryptoKey,
            privateKey: generatedPrivateKey as unknown as CryptoKey,
          });
      },
    );
  });
  privateKey = pair.privateKey;
  const publicJwk: JWK = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-rs256";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  jwks = { keys: [publicJwk] };
});

async function signedIdToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ org_id: ORG_ID, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-rs256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("provider|alice")
    .setIssuedAt(Math.floor(NOW.getTime() / 1000))
    .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 600)
    .sign(privateKey);
}

interface MockIdp {
  fetchImpl: typeof fetch;
  requests: Array<Record<string, string>>;
}

function makeMockIdp(
  respond: (parameters: Record<string, string>) => Promise<Response> | Response,
): MockIdp {
  const requests: Array<Record<string, string>> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(TOKEN_ENDPOINT);
    const parameters = Object.fromEntries(
      new URLSearchParams(String(init?.body ?? "")).entries(),
    );
    requests.push(parameters);
    return respond(parameters);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

interface BrowserAppOverrides {
  readonly resolveActor?: BrowserIdentityActorResolver;
  readonly sessions?: BrowserSessionStore;
  readonly bearerActorResolver?: (token: string) => HumanActor | null;
  readonly authRateLimit?:
    | false
    | {
        readonly capacity?: number;
        readonly refillPerSecond?: number;
        readonly maxClients?: number;
      };
}

function localActor(identity: VerifiedIdentity, role: HumanActor["role"] = "owner") {
  return createHumanActor({ ...identity, subjectId: LOCAL_USER_ID }, role);
}

function makeApp(
  idp: MockIdp,
  clock: () => Date = () => new Date(NOW.getTime()),
  overrides: BrowserAppOverrides = {},
) {
  const verifier = new OidcJwtIdentityVerifier({
    provider: "company-oidc",
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["RS256"],
    jwks,
    clock,
  });
  const app = createRegistryServer({
    clock,
    publicRateLimit: false,
    authRateLimit: overrides.authRateLimit,
    ...(overrides.bearerActorResolver
      ? {
          actorResolver: async (context) =>
            overrides.bearerActorResolver?.(context.bearerToken) ?? null,
        }
      : {}),
    browserAuth: {
      provider: "company-oidc",
      verifier,
      authorizationEndpoint: "https://identity.example.com/oauth/authorize",
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "pitlore-web",
      redirectUri: "https://registry.example.com/auth/callback",
      fetchImpl: idp.fetchImpl,
      resolveActor: overrides.resolveActor ?? ((identity) => localActor(identity)),
      ...(overrides.sessions ? { sessions: overrides.sessions } : {}),
    },
  });
  apps.push(app);
  return app;
}

function locationParams(location: string): URLSearchParams {
  return new URL(location).searchParams;
}

function cookieNamed(
  setCookie: string | string[] | undefined,
  name: string,
): string {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const raw = values.find((value) => value.startsWith(`${name}=`)) ?? "";
  const cookie = raw.split(";")[0] ?? "";
  expect(cookie.startsWith(`${name}=`)).toBe(true);
  return cookie;
}

function loginCookie(setCookie: string | string[] | undefined): string {
  return cookieNamed(setCookie, "__Host-pitlore_login");
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  return cookieNamed(setCookie, "__Host-pitlore_session");
}

function csrfCookie(setCookie: string | string[] | undefined): string {
  return cookieNamed(setCookie, "__Host-pitlore_csrf");
}

async function beginLogin(app: FastifyInstance, orgId = ORG_ID) {
  const response = await app.inject({
    method: "GET",
    url: `/auth/login?org_id=${encodeURIComponent(orgId)}`,
  });
  expect(response.statusCode).toBe(302);
  const params = locationParams(String(response.headers.location));
  return {
    response,
    params,
    state: params.get("state")!,
    nonce: params.get("nonce")!,
    cookie: loginCookie(response.headers["set-cookie"]),
  };
}

describe("Registry browser login (authorization code + PKCE)", () => {
  it("rate-limits the login and callback routes before handler work", async () => {
    const idp = makeMockIdp(() => new Response("{}", { status: 500 }));
    const limit = { capacity: 1, refillPerSecond: 0.001, maxClients: 8 };
    const loginApp = makeApp(idp, () => new Date(NOW.getTime()), {
      authRateLimit: limit,
    });

    expect(
      (
        await loginApp.inject({
          method: "GET",
          url: `/auth/login?org_id=${ORG_ID}`,
        })
      ).statusCode,
    ).toBe(302);
    const limitedLogin = await loginApp.inject({
      method: "GET",
      url: `/auth/login?org_id=${ORG_ID}`,
    });
    expect(limitedLogin.statusCode).toBe(429);
    expect(limitedLogin.headers["retry-after"]).toBe("1000");

    const callbackApp = makeApp(idp, () => new Date(NOW.getTime()), {
      authRateLimit: limit,
    });
    expect(
      (
        await callbackApp.inject({
          method: "GET",
          url: "/auth/callback",
        })
      ).statusCode,
    ).toBe(400);
    const limitedCallback = await callbackApp.inject({
      method: "GET",
      url: "/auth/callback",
    });
    expect(limitedCallback.statusCode).toBe(429);
    expect(limitedCallback.headers["retry-after"]).toBe("1000");
    expect(idp.requests).toEqual([]);
  });

  it("completes login against a mock IdP with S256 PKCE and a bound session cookie", async () => {
    let idToken = "";
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = makeApp(idp);

    const login = await beginLogin(app);
    const { params } = login;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("pitlore-web");
    expect(params.get("code_challenge_method")).toBe("S256");
    const state = login.state;
    const challenge = params.get("code_challenge")!;
    expect(login.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
    const rawLoginCookie = String(login.response.headers["set-cookie"]);
    expect(rawLoginCookie).toContain("__Host-pitlore_login=");
    expect(rawLoginCookie).toContain("Path=/");
    expect(rawLoginCookie).toContain("HttpOnly");
    expect(rawLoginCookie).toContain("Secure");
    expect(rawLoginCookie).toContain("SameSite=Lax");
    expect(rawLoginCookie).not.toContain("Domain=");
    idToken = await signedIdToken({ nonce: login.nonce });

    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: login.cookie },
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"]
      : [String(callback.headers["set-cookie"] ?? "")];
    expect(callbackCookies).toContainEqual(
      expect.stringContaining("__Host-pitlore_login="),
    );
    expect(callbackCookies).toContainEqual(expect.stringContaining("Max-Age=0"));
    const exchanged = idp.requests[0]!;
    expect(exchanged.grant_type).toBe("authorization_code");
    expect(exchanged.code).toBe("mock-code");
    expect(
      createHash("sha256").update(exchanged.code_verifier!, "ascii").digest("base64url"),
    ).toBe(challenge);

    const cookie = sessionCookie(callback.headers["set-cookie"]);
    const csrf = csrfCookie(callback.headers["set-cookie"]);
    const rawSetCookie = String(
      (Array.isArray(callback.headers["set-cookie"])
        ? callback.headers["set-cookie"]
        : [callback.headers["set-cookie"]])
        .find((value) => String(value).startsWith("__Host-pitlore_session=")),
    );
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("Secure");
    expect(rawSetCookie).toContain("SameSite=Strict");
    expect(rawSetCookie).not.toContain("Domain=");
    const rawCsrfCookie = String(
      (Array.isArray(callback.headers["set-cookie"])
        ? callback.headers["set-cookie"]
        : [callback.headers["set-cookie"]])
        .find((value) => String(value).startsWith("__Host-pitlore_csrf=")),
    );
    expect(rawCsrfCookie).toContain("Secure");
    expect(rawCsrfCookie).toContain("SameSite=Strict");
    expect(rawCsrfCookie).not.toContain("HttpOnly");
    expect(rawCsrfCookie).not.toContain("Domain=");

    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: true,
      org_id: ORG_ID,
      subject_id: LOCAL_USER_ID,
      role: "owner",
      provider: "company-oidc",
    });

    const csrfToken = csrf.split("=")[1]!;
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: `${cookie}; ${csrf}`,
        origin: REGISTRY_ORIGIN,
        "x-pitlore-csrf": csrfToken,
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain(
      "__Host-pitlore_session=",
    );
    expect(String(logout.headers["set-cookie"])).toContain(
      "__Host-pitlore_csrf=",
    );
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    const after = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(after.json()).toMatchObject({ authenticated: false });
  });

  it("rejects unknown, replayed, and expired states single-use", async () => {
    let idToken = "";
    let nowMs = NOW.getTime();
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(nowMs));

    const unknown = await app.inject({
      method: "GET",
      url: "/auth/callback?code=x&state=never-issued",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("invalid_state");

    const login = await beginLogin(app);
    const state = login.state;
    idToken = await signedIdToken({ nonce: login.nonce });
    const ok = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      headers: { cookie: login.cookie },
    });
    expect(ok.statusCode).toBe(303);
    const replay = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      headers: { cookie: login.cookie },
    });
    expect(replay.statusCode).toBe(400);

    const second = await beginLogin(app);
    const staleState = second.state;
    nowMs += 11 * 60 * 1000;
    const expired = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(staleState)}`,
      headers: { cookie: second.cookie },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe("invalid_state");
  });

  it("binds each state to the initiating browser and consumes mismatches", async () => {
    let idToken = "";
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp);
    const login = await beginLogin(app);
    idToken = await signedIdToken({ nonce: login.nonce });

    const swapped = await app.inject({
      method: "GET",
      url: `/auth/callback?code=attacker-code&state=${encodeURIComponent(login.state)}`,
    });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json().error.code).toBe("invalid_state");
    expect(String(swapped.headers["set-cookie"])).toContain(
      "__Host-pitlore_login=",
    );
    expect(String(swapped.headers["set-cookie"])).toContain("Max-Age=0");
    expect(idp.requests).toHaveLength(0);

    const retry = await app.inject({
      method: "GET",
      url: `/auth/callback?code=attacker-code&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    expect(retry.statusCode).toBe(400);
    expect(idp.requests).toHaveLength(0);
  });

  it("consumes a pending state when the IdP returns an error", async () => {
    let idToken = "";
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp);
    const login = await beginLogin(app);

    const denied = await app.inject({
      method: "GET",
      url: `/auth/callback?error=access_denied&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe("idp_denied");

    idToken = await signedIdToken({ nonce: login.nonce });
    const retry = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.code).toBe("invalid_state");
    expect(idp.requests).toHaveLength(0);
  });

  it("fails closed on IdP errors, failed exchanges, oversized responses, and rejected tokens", async () => {
    const denied = makeMockIdp(() => new Response("{}", { status: 200 }));
    const app = makeApp(denied);
    const idpError = await app.inject({
      method: "GET",
      url: "/auth/callback?error=access_denied&error_description=nope",
    });
    expect(idpError.statusCode).toBe(400);
    expect(idpError.json().error.code).toBe("idp_denied");
    expect(JSON.stringify(idpError.json())).not.toContain("nope");

    const login = await beginLogin(app);
    const state = login.state;
    const missingToken = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      headers: { cookie: login.cookie },
    });
    expect(missingToken.statusCode).toBe(502);
    expect(missingToken.json().error.code).toBe("idp_exchange_failed");

    const failing = makeMockIdp(() => new Response("{}", { status: 500 }));
    const failApp = makeApp(failing);
    const failLogin = await beginLogin(failApp);
    const failState = failLogin.state;
    const failed = await failApp.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(failState)}`,
      headers: { cookie: failLogin.cookie },
    });
    expect(failed.statusCode).toBe(502);

    const oversized = makeMockIdp(() =>
      new Response(
        JSON.stringify({ id_token: "a".repeat(300 * 1024) }),
        { status: 200 },
      ),
    );
    const oversizedApp = makeApp(oversized);
    const bigLogin = await beginLogin(oversizedApp);
    const bigState = bigLogin.state;
    const big = await oversizedApp.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(bigState)}`,
      headers: { cookie: bigLogin.cookie },
    });
    expect(big.statusCode).toBe(502);

    let wrongTenant = "";
    const mismatched = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: wrongTenant }), { status: 200 }),
    );
    const mismatchApp = makeApp(mismatched);
    const mLogin = await beginLogin(mismatchApp);
    const mState = mLogin.state;
    wrongTenant = await signedIdToken({
      org_id: "not-acme",
      nonce: mLogin.nonce,
    });
    const rejected = await mismatchApp.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(mState)}`,
      headers: { cookie: mLogin.cookie },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("identity_rejected");
  });

  it("requires a current local membership before creating a session", async () => {
    let idToken = "";
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(NOW.getTime()), {
      resolveActor: () => null,
    });
    const login = await beginLogin(app);
    idToken = await signedIdToken({ nonce: login.nonce });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("membership_required");
    expect(String(callback.headers["set-cookie"])).not.toContain(
      "__Host-pitlore_session=",
    );
  });

  it("reloads the current actor, binds it to the session tenant, and never falls back from Authorization", async () => {
    let idToken = "";
    let active = true;
    let role: HumanActor["role"] = "owner";
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(NOW.getTime()), {
      resolveActor: (identity) => active ? localActor(identity, role) : null,
    });
    const login = await beginLogin(app);
    idToken = await signedIdToken({ nonce: login.nonce });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    const cookie = sessionCookie(callback.headers["set-cookie"]);

    const me = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${ORG_ID}`,
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.json().data).toMatchObject({
      tenant_id: ORG_ID,
      subject_id: LOCAL_USER_ID,
      role: "owner",
    });

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${OTHER_ORG_ID}`,
      headers: { cookie },
    });
    expect(otherTenant.statusCode).toBe(404);

    for (const authorization of ["Basic abc", "Bearer bad", "Bearer "]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/v1/me?org_id=${ORG_ID}`,
        headers: { cookie, authorization },
      });
      expect(rejected.statusCode).toBe(401);
    }
    const stillValid = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${ORG_ID}`,
      headers: { cookie },
    });
    expect(stillValid.statusCode).toBe(200);

    role = "viewer";
    const changedRole = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(changedRole.json()).toMatchObject({
      authenticated: true,
      subject_id: LOCAL_USER_ID,
      role: "viewer",
    });

    active = false;
    const suspended = await app.inject({
      method: "GET",
      url: `/v1/me?org_id=${ORG_ID}`,
      headers: { cookie },
    });
    expect(suspended.statusCode).toBe(401);
    expect(suspended.headers["cache-control"]).toBe("no-store");
    expect(String(suspended.headers["set-cookie"])).toContain(
      "__Host-pitlore_session=",
    );
    expect(String(suspended.headers["set-cookie"])).toContain(
      "__Host-pitlore_csrf=",
    );

    active = true;
    const cannotRevive = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(cannotRevive.json()).toEqual({ authenticated: false });
  });

  it("requires exact Origin and session-bound CSRF for cookie mutations while bearer stays independent", async () => {
    let idToken = "";
    const bearerToken = `pit_${"A".repeat(43)}`;
    const viewerBearerToken = `pit_${"B".repeat(43)}`;
    const bearerIdentity: VerifiedIdentity = {
      provider: "company-oidc",
      issuer: ISSUER,
      providerSubjectId: "provider|bearer",
      subjectId: LOCAL_USER_ID,
      tenantId: ORG_ID,
      verifiedAt: NOW.toISOString(),
    };
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(NOW.getTime()), {
      bearerActorResolver: (token) =>
        token === bearerToken
          ? localActor(bearerIdentity)
          : token === viewerBearerToken
            ? localActor(bearerIdentity, "viewer")
            : null,
    });

    const login = await beginLogin(app);
    idToken = await signedIdToken({ nonce: login.nonce });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=a&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    const session = sessionCookie(callback.headers["set-cookie"]);
    const csrf = csrfCookie(callback.headers["set-cookie"]);
    const csrfToken = csrf.split("=")[1]!;
    const cookies = `${session}; ${csrf}`;
    const issueBody = JSON.stringify({
      scopes: ["pack:read"],
      expires_at: "2026-07-19T00:00:00.000Z",
    });
    const issue = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `/v1/orgs/${ORG_ID}/tokens`,
        headers: { "content-type": "application/json", ...headers },
        payload: issueBody,
      });

    for (const headers of [
      { cookie: cookies },
      { cookie: cookies, origin: "https://evil.example.com", "x-pitlore-csrf": csrfToken },
      { cookie: cookies, origin: "null", "x-pitlore-csrf": csrfToken },
      { cookie: cookies, origin: REGISTRY_ORIGIN },
      { cookie: cookies, origin: REGISTRY_ORIGIN, "x-pitlore-csrf": "x".repeat(43) },
    ]) {
      const rejected = await issue(headers);
      expect(rejected.statusCode).toBe(403);
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.json().error.code).toBe("csrf_rejected");
    }

    const secondLogin = await beginLogin(app);
    idToken = await signedIdToken({ nonce: secondLogin.nonce });
    const secondCallback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=b&state=${encodeURIComponent(secondLogin.state)}`,
      headers: { cookie: secondLogin.cookie },
    });
    const secondCsrf = csrfCookie(secondCallback.headers["set-cookie"]);
    const secondCsrfToken = secondCsrf.split("=")[1]!;
    const crossSession = await issue({
      cookie: `${session}; ${secondCsrf}`,
      origin: REGISTRY_ORIGIN,
      "x-pitlore-csrf": secondCsrfToken,
    });
    expect(crossSession.statusCode).toBe(403);

    const accepted = await issue({
      cookie: cookies,
      origin: REGISTRY_ORIGIN,
      "x-pitlore-csrf": csrfToken,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers["cache-control"]).toBe("no-store");

    const bearerAccepted = await issue({
      cookie: cookies,
      authorization: `Bearer ${bearerToken}`,
    });
    expect(bearerAccepted.statusCode).toBe(201);

    const viewerBearerRejected = await issue({
      cookie: cookies,
      authorization: `Bearer ${viewerBearerToken}`,
    });
    expect(viewerBearerRejected.statusCode).toBe(403);
    expect(viewerBearerRejected.json().error.code).toBe("forbidden");

    const forgedLogout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookies, origin: "https://evil.example.com" },
    });
    expect(forgedLogout.statusCode).toBe(403);
    const survivesForgery = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: cookies },
    });
    expect(survivesForgery.json()).toMatchObject({ authenticated: true });

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: cookies,
        origin: REGISTRY_ORIGIN,
        "x-pitlore-csrf": csrfToken,
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect(String(logout.headers["set-cookie"])).toContain("__Host-pitlore_session=");
    expect(String(logout.headers["set-cookie"])).toContain("__Host-pitlore_csrf=");
  });

  it("fails closed and clears client cookies when a store returns an invalid expiry", async () => {
    let idToken = "";
    let stored: BrowserSessionRecord | null = null;
    let deleted = false;
    const sessions: BrowserSessionStore = {
      create(record) {
        stored = { ...record, expiresAt: "not-a-timestamp" };
      },
      get() {
        return stored;
      },
      delete() {
        deleted = true;
        stored = null;
      },
    };
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(NOW.getTime()), { sessions });
    const login = await beginLogin(app);
    idToken = await signedIdToken({ nonce: login.nonce });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(login.state)}`,
      headers: { cookie: login.cookie },
    });
    const session = sessionCookie(callback.headers["set-cookie"]);
    const response = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: session },
    });
    expect(response.json()).toEqual({ authenticated: false });
    expect(deleted).toBe(true);
    expect(String(response.headers["set-cookie"])).toContain("__Host-pitlore_session=");
    expect(String(response.headers["set-cookie"])).toContain("__Host-pitlore_csrf=");
  });

  it("expires sessions at their absolute deadline", async () => {
    let idToken = "";
    let nowMs = NOW.getTime();
    const idp = makeMockIdp(() =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const app = makeApp(idp, () => new Date(nowMs));
    const login = await beginLogin(app);
    const state = login.state;
    idToken = await signedIdToken({ nonce: login.nonce });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      headers: { cookie: login.cookie },
    });
    const cookie = sessionCookie(callback.headers["set-cookie"]);

    nowMs += 12 * 60 * 60 * 1000 + 1_000;
    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(session.json()).toMatchObject({ authenticated: false });
    expect(String(session.headers["set-cookie"])).toContain(
      "__Host-pitlore_session=",
    );
    expect(String(session.headers["set-cookie"])).toContain(
      "__Host-pitlore_csrf=",
    );
    expect(String(session.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("rejects invalid endpoint configuration up front", () => {
    const idp = makeMockIdp(() => new Response("{}", { status: 200 }));
    const verifier = new OidcJwtIdentityVerifier({
      provider: "company-oidc",
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
      jwks,
    });
    const base = {
      provider: "company-oidc",
      verifier,
      authorizationEndpoint: "https://identity.example.com/oauth/authorize",
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "pitlore-web",
      redirectUri: "https://registry.example.com/auth/callback",
      fetchImpl: idp.fetchImpl,
      resolveActor: (identity: VerifiedIdentity) => localActor(identity),
    };
    for (const override of [
      { authorizationEndpoint: "http://identity.example.com/authorize" },
      { tokenEndpoint: "https://user:pw@identity.example.com/token" },
      { redirectUri: "https://registry.example.com/cb?next=x" },
      { clientId: "" },
    ]) {
      expect(() => {
        const app = createRegistryServer({
          publicRateLimit: false,
          browserAuth: { ...base, ...override },
        });
        apps.push(app);
      }).toThrow();
    }
  });
});
