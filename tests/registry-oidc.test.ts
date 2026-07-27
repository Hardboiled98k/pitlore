import { generateKeyPair } from "node:crypto";
import {
  SignJWT,
  exportJWK,
  type JWK,
  type JSONWebKeySet,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { OidcJwtIdentityVerifier } from "../src/registry-oidc.js";
import { IdentityProviderUnavailableError } from "../src/registry-auth.js";

const NOW = new Date("2026-07-16T10:00:00.000Z");
const ISSUER = "https://identity.example.com/";
const AUDIENCE = "pitlore-registry";
let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

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

describe("OIDC JWT identity verifier", () => {
  it("verifies a pinned asymmetric token and binds the exact tenant", async () => {
    const verifier = makeVerifier();
    const token = await signedToken();
    const identity = await verifier.verify({
      provider: "company-oidc",
      assertion: token,
      expectedTenantId: "acme",
    });
    expect(identity).toMatchObject({
      provider: "company-oidc",
      issuer: ISSUER,
      providerSubjectId: "provider|alice",
      tenantId: "acme",
      verifiedAt: NOW.toISOString(),
    });
    expect(identity?.subjectId).toMatch(/^oidc:[a-f0-9]{64}$/);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("requires an exact nonce only when an interactive flow supplies one", async () => {
    const verifier = makeVerifier();
    const nonce = "n".repeat(43);
    const bound = await signedToken({ nonce });
    await expect(
      verifier.verify({
        provider: "company-oidc",
        assertion: bound,
        expectedTenantId: "acme",
        expectedNonce: nonce,
      }),
    ).resolves.toMatchObject({ providerSubjectId: "provider|alice" });
    for (const assertion of [
      await signedToken(),
      await signedToken({ nonce: "x".repeat(43) }),
    ]) {
      await expect(
        verifier.verify({
          provider: "company-oidc",
          assertion,
          expectedTenantId: "acme",
          expectedNonce: nonce,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      verifier.verify({
        provider: "company-oidc",
        assertion: await signedToken(),
        expectedTenantId: "acme",
      }),
    ).resolves.toMatchObject({ providerSubjectId: "provider|alice" });
  });

  it("rejects wrong provider, tenant, issuer, audience, expiry, and future nbf", async () => {
    const verifier = makeVerifier();
    const valid = await signedToken();
    expect(
      await verifier.verify({
        provider: "other-oidc",
        assertion: valid,
        expectedTenantId: "acme",
      }),
    ).toBeNull();
    expect(
      await verifier.verify({
        provider: "company-oidc",
        assertion: valid,
        expectedTenantId: "beta",
      }),
    ).toBeNull();
    for (const token of [
      await signedToken({ issuer: "https://evil.example.com/" }),
      await signedToken({ audience: "another-service" }),
      await signedToken({ expiresAt: Math.floor(NOW.getTime() / 1_000) - 60 }),
      await signedToken({ notBefore: Math.floor(NOW.getTime() / 1_000) + 60 }),
    ]) {
      expect(
        await verifier.verify({
          provider: "company-oidc",
          assertion: token,
          expectedTenantId: "acme",
        }),
      ).toBeNull();
    }
  });

  it("rejects unsecured and non-allowlisted symmetric algorithms", async () => {
    const verifier = makeVerifier();
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "provider|alice",
        org_id: "acme",
        iat: Math.floor(NOW.getTime() / 1_000),
        exp: Math.floor(NOW.getTime() / 1_000) + 600,
      }),
    ).toString("base64url");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "test-rs256" })).toString("base64url")}.${payload}.`;
    expect(
      await verifier.verify({
        provider: "company-oidc",
        assertion: none,
        expectedTenantId: "acme",
      }),
    ).toBeNull();
    expect(() =>
      new OidcJwtIdentityVerifier({
        provider: "company-oidc",
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        jwks,
      }),
    ).toThrow(/allowed asymmetric/);
  });

  it("requires bounded fixed configuration and credential-free HTTPS endpoints", () => {
    expect(() =>
      new OidcJwtIdentityVerifier({
        provider: "company-oidc",
        issuer: "https://user:secret@identity.example.com/",
        audience: AUDIENCE,
        algorithms: ["RS256"],
        jwks,
      }),
    ).toThrow(/credential-free HTTPS/);
    expect(() =>
      new OidcJwtIdentityVerifier({
        provider: "company-oidc",
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [],
        jwks,
      }),
    ).toThrow(/explicitly configured/);
    expect(() =>
      new OidcJwtIdentityVerifier({
        provider: "company-oidc",
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["RS256"],
        jwks: new URL("http://identity.example.com/jwks.json"),
      }),
    ).toThrow(/credential-free HTTPS/);
  });

  it("distinguishes remote JWKS outages from invalid bearer assertions", async () => {
    const verifier = new OidcJwtIdentityVerifier({
      provider: "company-oidc",
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
      jwks: new URL("https://identity.example.com/jwks.json"),
      clock: () => NOW,
      remoteJwks: {
        fetchImpl: async () => {
          throw new TypeError("network unavailable");
        },
      },
    });
    await expect(
      verifier.verify({
        provider: "company-oidc",
        assertion: await signedToken(),
        expectedTenantId: "acme",
      }),
    ).rejects.toBeInstanceOf(IdentityProviderUnavailableError);

    await expect(
      makeVerifier().verify({
        provider: "company-oidc",
        assertion: "not-a-jwt",
        expectedTenantId: "acme",
      }),
    ).resolves.toBeNull();
  });
});

function makeVerifier(): OidcJwtIdentityVerifier {
  return new OidcJwtIdentityVerifier({
    provider: "company-oidc",
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["RS256"],
    jwks,
    clock: () => NOW,
    clockToleranceSeconds: 0,
    maxTokenAgeSeconds: 3_600,
  });
}

async function signedToken(
  options: {
    issuer?: string;
    audience?: string;
    expiresAt?: number;
    notBefore?: number;
    nonce?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(NOW.getTime() / 1_000);
  let token = new SignJWT({
    org_id: "acme",
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-rs256", typ: "JWT" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject("provider|alice")
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 600);
  if (options.notBefore !== undefined) token = token.setNotBefore(options.notBefore);
  return token.sign(privateKey);
}
