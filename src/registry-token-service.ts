import { randomUUID } from "node:crypto";
import {
  issueApiToken,
  revokeApiToken,
  assertTenantAuthorized,
  apiTokenLookupHash,
  authenticateApiToken,
  RegistryAuthorizationError,
  type ApiTokenRecord,
  type IssuedApiToken,
  type RegistryActor,
  type RegistryPermission,
} from "./registry-auth.js";
import {
  PostgresRegistryRepository,
  RegistryStorageNotFoundError,
  type StoredRegistryApiToken,
} from "./registry-postgres.js";
import {
  ListRegistryTokensPageInputSchema,
  decodeRegistryTokenCursor,
  encodeRegistryTokenCursor,
  type RegistryPage,
} from "./registry-domain.js";
import type { RegistryMaybePromise } from "./registry-port.js";
import type { z } from "zod";

export interface RegistryTokenIssueInput {
  readonly scopes: readonly RegistryPermission[];
  readonly expiresAt: string;
}

export interface RegistryTokenService {
  listApiTokens(): RegistryMaybePromise<readonly ApiTokenRecord[]>;
  authenticate(
    token: string,
    now?: Date,
  ): RegistryMaybePromise<RegistryActor | null>;
  listForOrganization(
    actor: RegistryActor,
    orgId: string,
  ): RegistryMaybePromise<readonly ApiTokenRecord[]>;
  listForOrganizationPage(
    actor: RegistryActor,
    orgId: string,
    options?: Omit<
      z.input<typeof ListRegistryTokensPageInputSchema>,
      "org_id"
    >,
  ): RegistryMaybePromise<RegistryPage<ApiTokenRecord>>;
  issue(
    actor: RegistryActor,
    orgId: string,
    input: RegistryTokenIssueInput,
    requestId: string,
  ): RegistryMaybePromise<IssuedApiToken>;
  revoke(
    actor: RegistryActor,
    orgId: string,
    tokenId: string,
    requestId: string,
  ): RegistryMaybePromise<ApiTokenRecord>;
  revokeForSubject(
    actor: RegistryActor,
    orgId: string,
    subjectId: string,
    requestId: string,
  ): RegistryMaybePromise<number>;
}

export class RegistryTokenNotFoundError extends Error {
  constructor() {
    super("Registry API token not found");
    this.name = "RegistryTokenNotFoundError";
  }
}

export class InMemoryRegistryTokenService implements RegistryTokenService {
  readonly #records = new Map<string, ApiTokenRecord>();
  readonly #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  listApiTokens(): readonly ApiTokenRecord[] {
    return [...this.#records.values()].map(cloneRecord);
  }

  authenticate(token: string, now = this.#clock()): RegistryActor | null {
    return authenticateApiToken(token, this.listApiTokens(), now);
  }

  listForOrganization(actor: RegistryActor, orgId: string): readonly ApiTokenRecord[] {
    assertHumanTenantActor(actor, orgId, "token:issue");
    return this.listApiTokens().filter((record) => record.tenantId === orgId);
  }

  listForOrganizationPage(
    actor: RegistryActor,
    orgId: string,
    options: Omit<
      z.input<typeof ListRegistryTokensPageInputSchema>,
      "org_id"
    > = {},
  ): RegistryPage<ApiTokenRecord> {
    assertHumanTenantActor(actor, orgId, "token:issue");
    const parsed = ListRegistryTokensPageInputSchema.parse({
      org_id: orgId,
      ...options,
    });
    const after = decodeRegistryTokenCursor(parsed.cursor, orgId);
    const matches = this.listApiTokens()
      .filter(
        (record) =>
          record.tenantId === orgId &&
          (after === undefined || compareTokenPosition(record, after) > 0),
      )
      .sort(compareTokenPosition)
      .slice(0, parsed.limit + 1);
    const items = matches.slice(0, parsed.limit);
    const last = items[items.length - 1];
    return {
      items,
      next_cursor:
        matches.length > parsed.limit && last
          ? encodeRegistryTokenCursor(orgId, {
              createdAt: last.createdAt,
              tokenId: last.tokenId,
            })
          : null,
    };
  }

  issue(
    actor: RegistryActor,
    orgId: string,
    input: RegistryTokenIssueInput,
    _requestId: string,
  ): IssuedApiToken {
    assertHumanTenantActor(actor, orgId, "token:issue");
    const issued = issueApiToken(
      {
        tenantId: orgId,
        subjectId: actor.subjectId,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      },
      this.#clock(),
    );
    this.#records.set(issued.record.tokenId, issued.record);
    return issued;
  }

  revoke(
    actor: RegistryActor,
    orgId: string,
    tokenId: string,
    _requestId: string,
  ): ApiTokenRecord {
    assertHumanTenantActor(actor, orgId, "token:revoke");
    const current = this.#records.get(tokenId);
    if (!current || current.tenantId !== orgId) {
      throw new RegistryTokenNotFoundError();
    }
    const revoked = revokeApiToken(current, this.#clock());
    this.#records.set(tokenId, revoked);
    return revoked;
  }

  revokeForSubject(
    actor: RegistryActor,
    orgId: string,
    subjectId: string,
    _requestId: string,
  ): number {
    assertHumanTenantActor(actor, orgId, "token:revoke");
    const now = this.#clock();
    let revokedCount = 0;
    for (const [tokenId, current] of this.#records) {
      if (
        current.tenantId !== orgId ||
        current.subjectId !== subjectId ||
        current.revokedAt !== null
      ) {
        continue;
      }
      this.#records.set(tokenId, revokeApiToken(current, now));
      revokedCount += 1;
    }
    return revokedCount;
  }
}

export class PostgresRegistryTokenService implements RegistryTokenService {
  readonly #repository: PostgresRegistryRepository;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  constructor(
    repository: PostgresRegistryRepository,
    options: { clock?: () => Date; idFactory?: () => string } = {},
  ) {
    this.#repository = repository;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async listApiTokens(): Promise<readonly ApiTokenRecord[]> {
    return this.#repository.listApiTokens();
  }

  async authenticate(token: string, now = this.#now()): Promise<RegistryActor | null> {
    const sha256 = apiTokenLookupHash(token);
    if (!sha256) return null;
    const record = await this.#repository.getActiveApiTokenByHash(sha256);
    return authenticateApiToken(token, record ? [record] : [], now);
  }

  async listForOrganization(
    actor: RegistryActor,
    orgId: string,
  ): Promise<readonly ApiTokenRecord[]> {
    assertHumanTenantActor(actor, orgId, "token:issue");
    return this.#repository.tenantTransaction(orgId, async (repository) => {
      await assertCurrentPostgresActor(repository, actor, orgId, "token:issue");
      return repository.listApiTokens(orgId);
    });
  }

  async listForOrganizationPage(
    actor: RegistryActor,
    orgId: string,
    options: Omit<
      z.input<typeof ListRegistryTokensPageInputSchema>,
      "org_id"
    > = {},
  ): Promise<RegistryPage<ApiTokenRecord>> {
    assertHumanTenantActor(actor, orgId, "token:issue");
    const parsed = ListRegistryTokensPageInputSchema.parse({
      org_id: orgId,
      ...options,
    });
    return this.#repository.tenantTransaction(orgId, async (repository) => {
      await assertCurrentPostgresActor(repository, actor, orgId, "token:issue");
      const after = decodeRegistryTokenCursor(parsed.cursor, orgId);
      const matches = await repository.listApiTokenPage(orgId, {
        ...(after === undefined ? {} : {
          afterCreatedAt: after.createdAt,
          afterId: after.tokenId,
        }),
        limit: parsed.limit + 1,
      });
      const items = matches.slice(0, parsed.limit).map(cloneRecord);
      const last = items[items.length - 1];
      return {
        items,
        next_cursor:
          matches.length > parsed.limit && last
            ? encodeRegistryTokenCursor(orgId, {
                createdAt: last.createdAt,
                tokenId: last.tokenId,
              })
            : null,
      };
    });
  }

  async issue(
    actor: RegistryActor,
    orgId: string,
    input: RegistryTokenIssueInput,
    requestId: string,
  ): Promise<IssuedApiToken> {
    assertHumanTenantActor(actor, orgId, "token:issue");
    const now = this.#now();
    const issued = issueApiToken(
      {
        tenantId: orgId,
        subjectId: actor.subjectId,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      },
      now,
    );
    const record = await this.#repository.tenantTransaction(orgId, async (repository) => {
      await assertCurrentPostgresActor(repository, actor, orgId, "token:issue");
      const stored = await repository.insertApiToken(issued.record);
      await repository.appendAuditEvent({
        event_id: this.#idFactory(),
        request_id: requestId,
        org_id: orgId,
        actor_id: actor.subjectId,
        actor_kind: "human",
        action: "token.issued",
        target_type: "api_token",
        target_id: stored.tokenId,
        metadata: {
          prefix: stored.prefix,
          scopes: stored.scopes.join(","),
          expires_at: stored.expiresAt,
        },
        occurred_at: now.toISOString(),
      });
      return stored;
    });
    return Object.freeze({ token: issued.token, record: cloneRecord(record) });
  }

  async revoke(
    actor: RegistryActor,
    orgId: string,
    tokenId: string,
    requestId: string,
  ): Promise<ApiTokenRecord> {
    assertHumanTenantActor(actor, orgId, "token:revoke");
    const now = this.#now();
    try {
      return await this.#repository.tenantTransaction(orgId, async (repository) => {
        await assertCurrentPostgresActor(repository, actor, orgId, "token:revoke");
        const stored = await repository.revokeApiToken(
          orgId,
          tokenId,
          now.toISOString(),
        );
        await repository.appendAuditEvent({
          event_id: this.#idFactory(),
          request_id: requestId,
          org_id: orgId,
          actor_id: actor.subjectId,
          actor_kind: "human",
          action: "token.revoked",
          target_type: "api_token",
          target_id: stored.tokenId,
          metadata: { prefix: stored.prefix },
          occurred_at: now.toISOString(),
        });
        return cloneRecord(stored);
      });
    } catch (error) {
      if (error instanceof RegistryStorageNotFoundError) {
        throw new RegistryTokenNotFoundError();
      }
      throw error;
    }
  }

  async revokeForSubject(
    actor: RegistryActor,
    orgId: string,
    subjectId: string,
    requestId: string,
  ): Promise<number> {
    assertHumanTenantActor(actor, orgId, "token:revoke");
    const now = this.#now();
    return this.#repository.tenantTransaction(orgId, async (repository) => {
      await assertCurrentPostgresActor(repository, actor, orgId, "token:revoke");
      const revoked = await repository.revokeApiTokensForSubject(
        orgId,
        subjectId,
        now.toISOString(),
      );
      if (revoked.length > 0) {
        await repository.appendAuditEvent({
          event_id: this.#idFactory(),
          request_id: requestId,
          org_id: orgId,
          actor_id: actor.subjectId,
          actor_kind: "human",
          action: "token.subject_revoked",
          target_type: "member",
          target_id: subjectId,
          metadata: { revoked_token_count: revoked.length },
          occurred_at: now.toISOString(),
        });
      }
      return revoked.length;
    });
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Registry token clock returned an invalid Date");
    }
    return value;
  }
}

async function assertCurrentPostgresActor(
  repository: PostgresRegistryRepository,
  actor: RegistryActor,
  orgId: string,
  permission: "token:issue" | "token:revoke",
): Promise<void> {
  if (actor.kind !== "human") {
    throw new RegistryAuthorizationError("human_required");
  }
  const organization = await repository.lockOrganization(orgId);
  const user = await repository.getUser(actor.subjectId);
  const membership = await repository.getMember(orgId, actor.subjectId);
  if (!organization || !user || user.status !== "active" || !membership) {
    throw new RegistryAuthorizationError("permission_denied");
  }
  try {
    assertTenantAuthorized(
      { ...actor, role: membership.role },
      orgId,
      permission,
    );
  } catch {
    throw new RegistryAuthorizationError("permission_denied");
  }
}

function assertHumanTenantActor(
  actor: RegistryActor,
  orgId: string,
  permission: "token:issue" | "token:revoke",
): void {
  if (actor.kind !== "human" || actor.tenantId !== orgId) {
    throw new Error("Registry API token lifecycle requires a tenant human actor");
  }
  assertTenantAuthorized(actor, orgId, permission);
}

function cloneRecord(record: StoredRegistryApiToken | ApiTokenRecord): ApiTokenRecord {
  return Object.freeze({
    ...record,
    scopes: Object.freeze([...record.scopes]),
  });
}

function compareTokenPosition(
  left: Pick<ApiTokenRecord, "createdAt" | "tokenId">,
  right: Pick<ApiTokenRecord, "createdAt" | "tokenId">,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.tokenId === right.tokenId) return 0;
  return left.tokenId < right.tokenId ? -1 : 1;
}
