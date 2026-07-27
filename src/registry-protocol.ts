/**
 * Keep a single bearer assertion below Node's default aggregate HTTP header
 * limit while still allowing ordinary RSA/ECDSA OIDC JWTs. API tokens remain
 * much shorter and are validated separately by the authentication layer.
 */
export const MAX_REGISTRY_BEARER_TOKEN_LENGTH = 12 * 1024;

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/u;

export function isRegistryBearerToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REGISTRY_BEARER_TOKEN_LENGTH &&
    BEARER_TOKEN_PATTERN.test(value)
  );
}
