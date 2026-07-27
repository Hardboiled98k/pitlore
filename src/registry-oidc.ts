import { createHash } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import {
  IdentityProviderUnavailableError,
  type IdentityVerificationRequest,
  type IdentityVerifier,
  type VerifiedIdentity,
} from "./registry-auth.js";
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TENANT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const OIDC_NONCE = /^[A-Za-z0-9_-]{20,256}$/;
const ALLOWED_ASYMMETRIC_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

export interface OidcIdentityVerifierOptions {
  provider: string;
  issuer: string;
  audience: string | readonly string[];
  algorithms: readonly string[];
  jwks: JSONWebKeySet | URL;
  tenantClaim?: string;
  clock?: () => Date;
  clockToleranceSeconds?: number;
  maxTokenAgeSeconds?: number;
  remoteJwks?: {
    timeoutMs?: number;
    cooldownMs?: number;
    cacheMaxAgeMs?: number;
    fetchImpl?: typeof fetch;
  };
}

/**
 * Verifies signed OIDC JWT assertions against one operator-configured issuer
 * and JWKS. It does not perform discovery, login redirects, PKCE, sessions,
 * SAML, or SCIM; those remain deployment concerns outside this verifier.
 */
export class OidcJwtIdentityVerifier implements IdentityVerifier {
  readonly #provider: string;
  readonly #issuer: string;
  readonly #audience: string | string[];
  readonly #algorithms: string[];
  readonly #tenantClaim: string;
  readonly #clock: () => Date;
  readonly #clockToleranceSeconds: number;
  readonly #maxTokenAgeSeconds: number;
  readonly #keyResolver: JWTVerifyGetKey;

  constructor(options: OidcIdentityVerifierOptions) {
    if (!PROVIDER_ID.test(options.provider)) {
      throw new Error("OIDC provider must be a canonical lowercase identifier");
    }
    const issuer = canonicalizeOidcIssuer(options.issuer);
    const audience = normalizeAudience(options.audience);
    const algorithms = normalizeAlgorithms(options.algorithms);
    const tenantClaim = options.tenantClaim ?? "org_id";
    if (!CLAIM_NAME.test(tenantClaim)) {
      throw new Error("OIDC tenant claim name is invalid");
    }
    const clockToleranceSeconds = boundedInteger(
      options.clockToleranceSeconds ?? 30,
      0,
      300,
      "OIDC clock tolerance",
    );
    const maxTokenAgeSeconds = boundedInteger(
      options.maxTokenAgeSeconds ?? 3_600,
      1,
      86_400,
      "OIDC maximum token age",
    );

    this.#provider = options.provider;
    this.#issuer = issuer;
    this.#audience = audience;
    this.#algorithms = algorithms;
    this.#tenantClaim = tenantClaim;
    this.#clock = options.clock ?? (() => new Date());
    this.#clockToleranceSeconds = clockToleranceSeconds;
    this.#maxTokenAgeSeconds = maxTokenAgeSeconds;
    this.#keyResolver = makeKeyResolver(options.jwks, options.remoteJwks);
  }

  async verify(
    request: IdentityVerificationRequest,
  ): Promise<VerifiedIdentity | null> {
    if (
      request.provider !== this.#provider ||
      typeof request.assertion !== "string" ||
      request.assertion.length === 0 ||
      request.assertion.length > 32_768 ||
      !TENANT_ID.test(request.expectedTenantId) ||
      (request.expectedNonce !== undefined &&
        !OIDC_NONCE.test(request.expectedNonce))
    ) {
      return null;
    }

    const currentDate = this.#clock();
    if (!Number.isFinite(currentDate.getTime())) {
      throw new Error("OIDC verifier clock returned an invalid Date");
    }

    try {
      const { payload, protectedHeader } = await jwtVerify(
        request.assertion,
        this.#keyResolver,
        {
          issuer: this.#issuer,
          audience: this.#audience,
          algorithms: this.#algorithms,
          clockTolerance: this.#clockToleranceSeconds,
          currentDate,
          maxTokenAge: this.#maxTokenAgeSeconds,
          requiredClaims: [
            "sub",
            "iat",
            "exp",
            this.#tenantClaim,
            ...(request.expectedNonce === undefined ? [] : ["nonce"]),
          ],
        },
      );
      if (!protectedHeader.kid || typeof protectedHeader.kid !== "string") {
        return null;
      }
      const providerSubjectId = payload.sub;
      const tenantId = payload[this.#tenantClaim];
      if (
        typeof providerSubjectId !== "string" ||
        providerSubjectId.length === 0 ||
        providerSubjectId.length > 256 ||
        providerSubjectId.trim() !== providerSubjectId ||
        typeof tenantId !== "string" ||
        tenantId !== request.expectedTenantId ||
        (request.expectedNonce !== undefined &&
          payload.nonce !== request.expectedNonce)
      ) {
        return null;
      }
      return Object.freeze({
        provider: this.#provider,
        issuer: this.#issuer,
        providerSubjectId,
        subjectId: stableSubjectId(this.#issuer, providerSubjectId),
        tenantId,
        verifiedAt: currentDate.toISOString(),
      });
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError) throw error;
      return null;
    }
  }
}

function makeKeyResolver(
  source: JSONWebKeySet | URL,
  remoteOptions: OidcIdentityVerifierOptions["remoteJwks"],
): JWTVerifyGetKey {
  if (source instanceof URL) {
    const url = parseAbsoluteHttpsUrl(source.toString(), "OIDC JWKS URL", {
      allowQuery: false,
    });
    const resolver = createRemoteJWKSet(url, {
      timeoutDuration: boundedInteger(
        remoteOptions?.timeoutMs ?? 5_000,
        100,
        30_000,
        "OIDC JWKS timeout",
      ),
      cooldownDuration: boundedInteger(
        remoteOptions?.cooldownMs ?? 30_000,
        1_000,
        3_600_000,
        "OIDC JWKS cooldown",
      ),
      cacheMaxAge: boundedInteger(
        remoteOptions?.cacheMaxAgeMs ?? 600_000,
        1_000,
        86_400_000,
        "OIDC JWKS cache age",
      ),
      ...(remoteOptions?.fetchImpl
        ? { [customFetch]: remoteOptions.fetchImpl }
        : {}),
    });
    return async (protectedHeader, token) => {
      try {
        return await resolver(protectedHeader, token);
      } catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey) throw error;
        throw new IdentityProviderUnavailableError({ cause: error });
      }
    };
  }
  if (
    typeof source !== "object" ||
    source === null ||
    !Array.isArray(source.keys) ||
    source.keys.length === 0
  ) {
    throw new Error("OIDC local JWKS must contain at least one key");
  }
  return createLocalJWKSet(structuredClone(source));
}

function normalizeAudience(value: string | readonly string[]): string | string[] {
  const values = typeof value === "string" ? [value] : [...value];
  if (
    values.length === 0 ||
    values.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 256 ||
        entry.trim() !== entry,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("OIDC audience must contain unique bounded values");
  }
  return values.length === 1 ? values[0]! : values;
}

function normalizeAlgorithms(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("OIDC algorithms must be explicitly configured");
  }
  const algorithms = [...values];
  for (const algorithm of algorithms) {
    if (!ALLOWED_ASYMMETRIC_ALGORITHMS.has(algorithm)) {
      throw new Error(`OIDC algorithm is not an allowed asymmetric algorithm: ${algorithm}`);
    }
  }
  if (new Set(algorithms).size !== algorithms.length) {
    throw new Error("OIDC algorithms must be unique");
  }
  return algorithms;
}

function parseAbsoluteHttpsUrl(
  value: string,
  label: string,
  options: { allowQuery: boolean },
): URL {
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
    url.hash !== "" ||
    (!options.allowQuery && url.search !== "")
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

export function canonicalizeOidcIssuer(value: string): string {
  return parseAbsoluteHttpsUrl(value, "OIDC issuer", {
    allowQuery: false,
  }).toString();
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stableSubjectId(issuer: string, providerSubjectId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([issuer, providerSubjectId]), "utf8")
    .digest("hex");
  return `oidc:${digest}`;
}
