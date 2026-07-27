import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const REGISTRY_ROLES = Object.freeze([
  "viewer",
  "publisher",
  "admin",
  "owner",
] as const);
export type RegistryRole = (typeof REGISTRY_ROLES)[number];

export const REGISTRY_PERMISSIONS = Object.freeze([
  "pack:read",
  "pack:publish",
  "pack:deprecate",
  "member:read",
  "member:manage",
  "token:issue",
  "token:revoke",
  "audit:read",
  "organization:update",
  "organization:delete",
  "organization:transfer",
  "billing:manage",
] as const);
export type RegistryPermission = (typeof REGISTRY_PERMISSIONS)[number];

const VIEWER_PERMISSIONS = ["pack:read"] as const satisfies readonly RegistryPermission[];
const PUBLISHER_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  "pack:publish",
] as const satisfies readonly RegistryPermission[];
const ADMIN_PERMISSIONS = [
  ...PUBLISHER_PERMISSIONS,
  "pack:deprecate",
  "member:read",
  "member:manage",
  "token:issue",
  "token:revoke",
  "audit:read",
  "organization:update",
] as const satisfies readonly RegistryPermission[];

/**
 * The role matrix is deliberately additive: every stronger role contains all
 * permissions of the weaker role. Only an owner may delete/transfer an
 * organization or manage billing.
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<RegistryRole, readonly RegistryPermission[]>
> = Object.freeze({
  viewer: Object.freeze([...VIEWER_PERMISSIONS]),
  publisher: Object.freeze([...PUBLISHER_PERMISSIONS]),
  admin: Object.freeze([...ADMIN_PERMISSIONS]),
  owner: Object.freeze([...REGISTRY_PERMISSIONS]),
});

/** Service credentials are automation credentials, not substitute humans. */
export const SERVICE_ACTOR_PERMISSIONS = Object.freeze([
  "pack:read",
  "pack:publish",
] as const satisfies readonly RegistryPermission[]);

const ROLE_SET = new Set<string>(REGISTRY_ROLES);
const PERMISSION_SET = new Set<string>(REGISTRY_PERMISSIONS);
const SERVICE_PERMISSION_SET = new Set<string>(SERVICE_ACTOR_PERMISSIONS);
const TENANT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const API_TOKEN_PREFIX = "pit_";
const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_SECRET_LENGTH = 43;
const API_TOKEN_DISPLAY_SECRET_LENGTH = 10;
const API_TOKEN_PATTERN = new RegExp(
  `^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{${API_TOKEN_SECRET_LENGTH}}$`,
);
const API_TOKEN_DISPLAY_PREFIX_PATTERN = new RegExp(
  `^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{${API_TOKEN_DISPLAY_SECRET_LENGTH}}$`,
);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface VerifiedIdentity {
  readonly provider: string;
  /** Exact verified OIDC issuer namespace; never inferred from a provider alias. */
  readonly issuer: string;
  readonly providerSubjectId: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly verifiedAt: string;
}

export interface IdentityVerificationRequest {
  readonly provider: string;
  readonly assertion: string;
  /** The verifier must bind the assertion to this exact tenant. */
  readonly expectedTenantId: string;
  /** When supplied by an interactive OIDC flow, require this exact nonce claim. */
  readonly expectedNonce?: string;
}

/**
 * Production adapters verify the provider signature, issuer, audience,
 * algorithm allow-list and expiry, plus an exact nonce when the request
 * supplies one, before returning an identity.
 */
export interface IdentityVerifier {
  verify(request: IdentityVerificationRequest): Promise<VerifiedIdentity | null>;
}

export class IdentityProviderUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Registry identity provider is unavailable", options);
    this.name = "IdentityProviderUnavailableError";
  }
}

export interface DeterministicIdentityFixture {
  readonly assertion: string;
  readonly identity: VerifiedIdentity;
  readonly nonce?: string;
}

/**
 * A deterministic in-memory adapter for tests and local domain smoke tests.
 * It is intentionally not a JWT/OIDC implementation and must not be used as a
 * production identity provider.
 */
export class DeterministicIdentityVerifier implements IdentityVerifier {
  readonly #fixtures = new Map<
    string,
    { readonly identity: VerifiedIdentity; readonly nonce?: string }
  >();

  constructor(fixtures: readonly DeterministicIdentityFixture[]) {
    for (const fixture of fixtures) {
      if (typeof fixture.assertion !== "string" || fixture.assertion.length === 0) {
        throw new Error("Identity fixture assertion must not be empty");
      }
      if (fixture.nonce !== undefined && !isBoundedOidcNonce(fixture.nonce)) {
        throw new Error("Identity fixture nonce must be a bounded opaque value");
      }
      const identity = validateVerifiedIdentity(fixture.identity);
      const key = identityFixtureKey(identity.provider, fixture.assertion);
      if (this.#fixtures.has(key)) {
        throw new Error("Duplicate deterministic identity fixture");
      }
      this.#fixtures.set(key, { identity, nonce: fixture.nonce });
    }
  }

  async verify(
    request: IdentityVerificationRequest,
  ): Promise<VerifiedIdentity | null> {
    assertProviderId(request.provider);
    assertTenantId(request.expectedTenantId);
    if (typeof request.assertion !== "string" || request.assertion.length === 0) {
      return null;
    }
    const fixture = this.#fixtures.get(
      identityFixtureKey(request.provider, request.assertion),
    );
    if (
      !fixture ||
      fixture.identity.tenantId !== request.expectedTenantId ||
      (request.expectedNonce !== undefined &&
        (!isBoundedOidcNonce(request.expectedNonce) ||
          fixture.nonce !== request.expectedNonce))
    ) {
      return null;
    }
    return Object.freeze(cloneIdentity(fixture.identity));
  }
}

export interface HumanActor {
  readonly kind: "human";
  readonly tenantId: string;
  readonly subjectId: string;
  readonly role: RegistryRole;
  readonly identityProvider: string;
  readonly identityIssuer: string;
  readonly identityVerifiedAt: string;
}

export interface ServiceActor {
  readonly kind: "service";
  readonly tenantId: string;
  readonly subjectId: string;
  readonly tokenId: string;
  readonly scopes: readonly RegistryPermission[];
}

export type RegistryActor = HumanActor | ServiceActor;

export function createHumanActor(
  identity: VerifiedIdentity,
  role: RegistryRole,
): HumanActor {
  const verified = validateVerifiedIdentity(identity);
  assertRole(role);
  return Object.freeze({
    kind: "human",
    tenantId: verified.tenantId,
    subjectId: verified.subjectId,
    role,
    identityProvider: verified.provider,
    identityIssuer: verified.issuer,
    identityVerifiedAt: verified.verifiedAt,
  });
}

export type RegistryAuthorizationErrorCode =
  | "tenant_mismatch"
  | "human_required"
  | "permission_denied"
  | "invalid_actor";

export class RegistryAuthorizationError extends Error {
  constructor(readonly code: RegistryAuthorizationErrorCode) {
    super("Registry authorization denied");
    this.name = "RegistryAuthorizationError";
  }
}

/**
 * Authorize one tenant-scoped action. Tenant equality is exact and is checked
 * before role/scope evaluation; there is deliberately no wildcard tenant or
 * implicit platform-admin bypass.
 */
export function assertTenantAuthorized(
  actor: RegistryActor,
  targetTenantId: string,
  permission: RegistryPermission,
): void {
  try {
    assertTenantId(targetTenantId);
    assertTenantId(actor.tenantId);
    assertSubjectId(actor.subjectId);
    assertPermission(permission);
  } catch {
    throw new RegistryAuthorizationError("invalid_actor");
  }

  if (actor.tenantId !== targetTenantId) {
    throw new RegistryAuthorizationError("tenant_mismatch");
  }

  if (actor.kind === "human") {
    try {
      assertRole(actor.role);
      assertProviderId(actor.identityProvider);
      assertIdentityIssuer(actor.identityIssuer);
      parseCanonicalTimestamp(actor.identityVerifiedAt, "identityVerifiedAt");
    } catch {
      throw new RegistryAuthorizationError("invalid_actor");
    }
    if (!ROLE_PERMISSIONS[actor.role].includes(permission)) {
      throw new RegistryAuthorizationError("permission_denied");
    }
    return;
  }

  if (actor.kind !== "service") {
    throw new RegistryAuthorizationError("invalid_actor");
  }
  try {
    assertSubjectId(actor.tokenId);
    validateScopes(actor.scopes);
  } catch {
    throw new RegistryAuthorizationError("invalid_actor");
  }
  if (!SERVICE_PERMISSION_SET.has(permission)) {
    throw new RegistryAuthorizationError("human_required");
  }
  if (!actor.scopes.includes(permission)) {
    throw new RegistryAuthorizationError("permission_denied");
  }
}

export interface ApiTokenRecord {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly sha256: string;
  readonly prefix: string;
  readonly scopes: readonly RegistryPermission[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface IssueApiTokenInput {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly scopes: readonly RegistryPermission[];
  readonly expiresAt: Date | string;
}

export interface IssuedApiToken {
  /** Returned exactly once. Persist only `record`, never this bearer value. */
  readonly token: string;
  readonly record: ApiTokenRecord;
}

export function issueApiToken(
  input: IssueApiTokenInput,
  now: Date = new Date(),
): IssuedApiToken {
  assertTenantId(input.tenantId);
  assertSubjectId(input.subjectId);
  const scopes = validateScopes(input.scopes);
  const createdAt = canonicalTimestamp(now, "now");
  const expiresAt = canonicalTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error("API token expiry must be in the future");
  }

  const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
  if (secret.length !== API_TOKEN_SECRET_LENGTH) {
    throw new Error("Unexpected API token entropy encoding");
  }
  const token = `${API_TOKEN_PREFIX}${secret}`;
  const record = freezeTokenRecord({
    tokenId: randomUUID(),
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    sha256: hashToken(token).toString("hex"),
    prefix: `${API_TOKEN_PREFIX}${secret.slice(0, API_TOKEN_DISPLAY_SECRET_LENGTH)}`,
    scopes,
    createdAt,
    expiresAt,
    revokedAt: null,
  });
  return Object.freeze({ token, record });
}

/**
 * Authenticate a bearer token without ever comparing secret strings. All
 * stored hashes are decoded to fixed-size buffers and compared with
 * `timingSafeEqual`; malformed/corrupt records fail closed.
 */
export function authenticateApiToken(
  token: string,
  records: readonly ApiTokenRecord[],
  now: Date = new Date(),
): ServiceActor | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const formatValid = API_TOKEN_PATTERN.test(token);
  const suppliedHash = hashToken(token);
  const validatedRecords = records.map(validateApiTokenRecord);
  let match: ApiTokenRecord | undefined;

  for (const record of validatedRecords) {
    const expectedHash = Buffer.from(record.sha256, "hex");
    const equals = timingSafeEqual(suppliedHash, expectedHash);
    if (!equals) continue;
    if (match) throw new Error("Ambiguous duplicate API token records");
    match = record;
  }

  if (!formatValid || !match) return null;
  if (match.prefix !== token.slice(0, match.prefix.length)) {
    throw new Error("API token record prefix does not match its hash");
  }
  const nowMs = Date.parse(canonicalTimestamp(now, "now"));
  if (match.revokedAt !== null || nowMs >= Date.parse(match.expiresAt)) return null;

  return Object.freeze({
    kind: "service",
    tenantId: match.tenantId,
    subjectId: match.subjectId,
    tokenId: match.tokenId,
    scopes: Object.freeze([...match.scopes]),
  });
}

/** Returns the indexed lookup key only for a syntactically valid PitLore token. */
export function apiTokenLookupHash(token: unknown): string | null {
  if (typeof token !== "string" || !API_TOKEN_PATTERN.test(token)) return null;
  return hashToken(token).toString("hex");
}

export function revokeApiToken(
  record: ApiTokenRecord,
  revokedAt: Date = new Date(),
): ApiTokenRecord {
  const validated = validateApiTokenRecord(record);
  if (validated.revokedAt !== null) return validated;
  const timestamp = canonicalTimestamp(revokedAt, "revokedAt");
  if (Date.parse(timestamp) < Date.parse(validated.createdAt)) {
    throw new Error("API token cannot be revoked before it was created");
  }
  return freezeTokenRecord({ ...validated, revokedAt: timestamp });
}

function validateApiTokenRecord(record: ApiTokenRecord): ApiTokenRecord {
  assertSubjectId(record.tokenId);
  assertTenantId(record.tenantId);
  assertSubjectId(record.subjectId);
  if (!SHA256_HEX.test(record.sha256)) {
    throw new Error("API token record must contain a SHA-256 hash");
  }
  if (!API_TOKEN_DISPLAY_PREFIX_PATTERN.test(record.prefix)) {
    throw new Error("API token record contains an invalid display prefix");
  }
  const scopes = validateScopes(record.scopes);
  const createdAt = parseCanonicalTimestamp(record.createdAt, "createdAt");
  const expiresAt = parseCanonicalTimestamp(record.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) {
    throw new Error("API token record expiry must follow creation");
  }
  let revokedAt: string | null = null;
  if (record.revokedAt !== null) {
    const revokedAtMs = parseCanonicalTimestamp(record.revokedAt, "revokedAt");
    if (revokedAtMs < createdAt) {
      throw new Error("API token record revocation precedes creation");
    }
    revokedAt = record.revokedAt;
  }
  return freezeTokenRecord({
    tokenId: record.tokenId,
    tenantId: record.tenantId,
    subjectId: record.subjectId,
    sha256: record.sha256,
    prefix: record.prefix,
    scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt,
  });
}

function validateScopes(
  scopes: readonly RegistryPermission[],
): readonly RegistryPermission[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("API token scopes must not be empty");
  }
  const unique = new Set<RegistryPermission>();
  for (const scope of scopes) {
    assertPermission(scope);
    if (!SERVICE_PERMISSION_SET.has(scope)) {
      throw new Error(`API token scope requires a human actor: ${scope}`);
    }
    if (unique.has(scope)) throw new Error(`Duplicate API token scope: ${scope}`);
    unique.add(scope);
  }
  return Object.freeze([...unique].sort());
}

function validateVerifiedIdentity(identity: VerifiedIdentity): VerifiedIdentity {
  assertProviderId(identity.provider);
  assertIdentityIssuer(identity.issuer);
  assertOpaqueProviderSubject(identity.providerSubjectId);
  assertSubjectId(identity.subjectId);
  assertTenantId(identity.tenantId);
  parseCanonicalTimestamp(identity.verifiedAt, "verifiedAt");
  return Object.freeze(cloneIdentity(identity));
}

function cloneIdentity(identity: VerifiedIdentity): VerifiedIdentity {
  return {
    provider: identity.provider,
    issuer: identity.issuer,
    providerSubjectId: identity.providerSubjectId,
    subjectId: identity.subjectId,
    tenantId: identity.tenantId,
    verifiedAt: identity.verifiedAt,
  };
}

function assertIdentityIssuer(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Identity issuer must be an absolute credential-free HTTPS URL");
  }
  if (
    value.length > 2_048 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== value
  ) {
    throw new Error("Identity issuer must be an absolute credential-free HTTPS URL");
  }
}

function freezeTokenRecord(record: ApiTokenRecord): ApiTokenRecord {
  return Object.freeze({ ...record, scopes: Object.freeze([...record.scopes]) });
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function identityFixtureKey(provider: string, assertion: string): string {
  return JSON.stringify([provider, assertion]);
}

function assertRole(value: string): asserts value is RegistryRole {
  if (!ROLE_SET.has(value)) throw new Error(`Unknown registry role: ${value}`);
}

function assertPermission(value: string): asserts value is RegistryPermission {
  if (!PERMISSION_SET.has(value)) {
    throw new Error(`Unknown registry permission: ${value}`);
  }
}

function assertTenantId(value: string): void {
  if (typeof value !== "string" || !TENANT_ID.test(value)) {
    throw new Error("Tenant id must be a canonical lowercase identifier");
  }
}

function assertSubjectId(value: string): void {
  if (typeof value !== "string" || !SUBJECT_ID.test(value)) {
    throw new Error("Subject id must be a canonical identifier");
  }
}

function assertProviderId(value: string): void {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new Error("Identity provider must be a canonical lowercase identifier");
  }
}

function assertOpaqueProviderSubject(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Provider subject must be a bounded opaque identifier");
  }
}

function isBoundedOidcNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function canonicalTimestamp(value: Date | string, label: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be valid`);
    return value.toISOString();
  }
  parseCanonicalTimestamp(value, label);
  return value;
}

function parseCanonicalTimestamp(value: string, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return date.getTime();
}
