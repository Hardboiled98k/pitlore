import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RegistryPackArtifactSchema, serializeRegistryPackArtifact, type RegistryPackArtifact } from "./registry-artifact.js";
import {
  AddRegistryMemberInputSchema,
  CreateRegistryPackageInputSchema,
  decodeRegistryAuditCursor,
  decodeRegistryMemberCursor,
  decodeRegistryPackageCursor,
  decodeRegistryReleaseCursor,
  decodePublicRegistryPackageCursor,
  decodePublicRegistryReleaseCursor,
  encodeRegistryAuditCursor,
  encodeRegistryMemberCursor,
  encodeRegistryPackageCursor,
  encodeRegistryReleaseCursor,
  encodePublicRegistryPackageCursor,
  encodePublicRegistryReleaseCursor,
  GetPublicRegistryPackageInputSchema,
  GetPublicRegistryReleaseInputSchema,
  GetRegistryPackageInputSchema,
  ListRegistryReleasesInputSchema,
  ListRegistryAuditEventsPageInputSchema,
  ListRegistryMembersPageInputSchema,
  ListRegistryPackagesPageInputSchema,
  ListRegistryReleasesPageInputSchema,
  ListPublicRegistryReleasesInputSchema,
  RegistryAuditEventSchema,
  RegistryArtifactSchema,
  RegistryConflictError,
  RegistryForbiddenError,
  RegistryMemberSchema,
  RegistryNotFoundError,
  RegistryOrganizationIdentityInputSchema,
  ProvisionExternalRegistryMemberInputSchema,
  RegistryPackageSchema,
  PublicRegistryPackageSearchHitSchema,
  RegistryReleaseSchema,
  RegistrySeatLimitError,
  RegistryTransitionError,
  RejectRegistryReleaseInputSchema,
  RemoveRegistryMemberInputSchema,
  ReviewRegistryReleaseInputSchema,
  SearchPublicRegistryPackagesInputSchema,
  SubmitRegistryReleaseInputSchema,
  UpdateRegistryMemberInputSchema,
  YankRegistryReleaseInputSchema,
  type RegistryMember,
  type RegistryAuditEvent,
  type RegistryPackage,
  type PublicRegistryPackageSearchHit,
  type RegistryPage,
  type PublicRegistryPage,
  type RegistryRelease,
  type RegistryRole,
} from "./registry-domain.js";
import {
  PostgresRegistryRepository,
  RegistryStorageConflictError,
  RegistryStorageForbiddenError,
  RegistryStorageNotFoundError,
  RegistryStorageTransitionError,
  type RegistryJsonObject,
  type StoredRegistryAuditEvent,
  type StoredRegistryPackage,
  type StoredPublicRegistryPackageSearchHit,
  type StoredRegistryRelease,
  type StoredRegistryReleaseApproval,
} from "./registry-postgres.js";
import type {
  RegistryDomainPort,
  RegistryMutationContext,
  RegistryPublicRelease,
} from "./registry-port.js";
import {
  PublicPackDiscoveryDocumentSchema,
  type PublicPackDiscoveryDocument,
} from "./registry-search.js";
import { entitlementsForPlan } from "./registry-telemetry.js";

const WRITER_ROLES = new Set<RegistryRole>(["publisher", "admin", "owner"]);
const ADMIN_ROLES = new Set<RegistryRole>(["admin", "owner"]);

export interface PostgresRegistryApplicationOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  /** When set by the runtime, seat limits are resolved under the org row lock. */
  readonly billingMode?: "off" | "enforced";
}

/** Durable Registry domain adapter backed by the normalized PostgreSQL schema. */
export class PostgresRegistryApplication implements RegistryDomainPort {
  readonly managesMemberTokenRevocation = true;
  readonly #repository: PostgresRegistryRepository;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #billingMode: "off" | "enforced" | undefined;

  constructor(
    repository: PostgresRegistryRepository,
    options: PostgresRegistryApplicationOptions = {},
  ) {
    this.#repository = repository;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#billingMode = options.billingMode;
  }

  async searchPublicPackages(
    input: z.input<typeof SearchPublicRegistryPackagesInputSchema> = {},
  ): Promise<PublicRegistryPage<PublicRegistryPackageSearchHit>> {
    const parsed = SearchPublicRegistryPackagesInputSchema.parse(input);
    const filters = {
      languages: parsed.languages,
      ecosystems: parsed.ecosystems,
      tags: parsed.tags,
    };
    const afterName = decodePublicRegistryPackageCursor(
      parsed.cursor,
      parsed.query,
      filters,
    );
    return this.#storage(async () => {
      const matches = await this.#repository.listPublicPackages({
        query: parsed.query,
        filters,
        ...(afterName === undefined ? {} : { afterName }),
        limit: parsed.limit + 1,
      });
      const pageItems = matches.slice(0, parsed.limit);
      return {
        items: pageItems.map(mapPublicPackageSearchHit),
        next_cursor:
          matches.length > parsed.limit
            ? encodePublicRegistryPackageCursor(
                parsed.query,
                pageItems[pageItems.length - 1]!.name,
                filters,
              )
            : null,
      };
    });
  }

  async getPublicPackage(
    input: z.input<typeof GetPublicRegistryPackageInputSchema>,
  ): Promise<RegistryPackage> {
    const parsed = GetPublicRegistryPackageInputSchema.parse(input);
    return this.#storage(async () => {
      const item = await this.#repository.getPublicPackage(parsed.name);
      if (!item) throw new RegistryStorageNotFoundError("Public package not found");
      return mapPackage(item);
    });
  }

  async getPublicRelease(
    input: z.input<typeof GetPublicRegistryReleaseInputSchema>,
  ): Promise<RegistryPublicRelease> {
    const parsed = GetPublicRegistryReleaseInputSchema.parse(input);
    return this.#storage(async () => {
      const item = await this.#repository.getPublicRelease(
        parsed.package_name,
        parsed.version,
      );
      if (!item) throw new RegistryStorageNotFoundError("Public release not found");
      return this.#mapPublicRelease(item);
    });
  }

  async listPublicReleases(
    input: z.input<typeof ListPublicRegistryReleasesInputSchema>,
  ): Promise<PublicRegistryPage<RegistryPublicRelease>> {
    const parsed = ListPublicRegistryReleasesInputSchema.parse(input);
    const afterVersion = decodePublicRegistryReleaseCursor(
      parsed.cursor,
      parsed.package_name,
    );
    return this.#storage(async () => {
      const registryPackage = await this.#repository.getPublicPackage(
        parsed.package_name,
      );
      if (!registryPackage) {
        throw new RegistryStorageNotFoundError("Public package not found");
      }
      const releases = await this.#repository.listPublicReleases(
        registryPackage.name,
        {
          ...(afterVersion === undefined ? {} : { afterVersion }),
          limit: parsed.limit + 1,
        },
      );
      const pageItems = releases.slice(0, parsed.limit);
      return {
        items: pageItems.map((item) => this.#mapPublicRelease(item)),
        next_cursor:
          releases.length > parsed.limit
            ? encodePublicRegistryReleaseCursor(
                parsed.package_name,
                pageItems[pageItems.length - 1]!.version,
              )
            : null,
      };
    });
  }

  async listPackages(
    actorUserId: string,
    input: z.input<typeof RegistryOrganizationIdentityInputSchema>,
  ): Promise<RegistryPackage[]> {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        return (await repository.listPackages(parsed.org_id)).map(mapPackage);
      }),
    );
  }

  async listPackagePage(
    actorUserId: string,
    input: z.input<typeof ListRegistryPackagesPageInputSchema>,
  ): Promise<RegistryPage<RegistryPackage>> {
    const parsed = ListRegistryPackagesPageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        const afterName = decodeRegistryPackageCursor(
          parsed.cursor,
          parsed.org_id,
        );
        const matches = await repository.listPackagePage(parsed.org_id, {
          ...(afterName === undefined ? {} : { after: afterName }),
          limit: parsed.limit + 1,
        });
        const items = matches.slice(0, parsed.limit).map(mapPackage);
        return {
          items,
          next_cursor:
            matches.length > parsed.limit
              ? encodeRegistryPackageCursor(
                  parsed.org_id,
                  items[items.length - 1]!.name,
                )
              : null,
        };
      }),
    );
  }

  async getPackage(
    actorUserId: string,
    input: z.input<typeof GetRegistryPackageInputSchema>,
  ): Promise<RegistryPackage> {
    const parsed = GetRegistryPackageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        return mapPackage(
          await this.#requirePackage(parsed.org_id, parsed.name, repository),
        );
      }),
    );
  }

  async createPackage(
    actorUserId: string,
    input: z.input<typeof CreateRegistryPackageInputSchema>,
  ): Promise<RegistryPackage> {
    return this.createPackageWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async createPackageWithContext(
    actorUserId: string,
    input: z.input<typeof CreateRegistryPackageInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryPackage> {
    const parsed = CreateRegistryPackageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        const membership = await this.#requireRole(
          actorUserId,
          parsed.org_id,
          WRITER_ROLES,
          repository,
        );
        const organization = await repository.getOrganization(parsed.org_id);
        if (!organization) throw new RegistryStorageNotFoundError("Organization not found");
        if (!parsed.name.startsWith(`${organization.slug}/`)) {
          throw new RegistryStorageConflictError(
            `Package must use organization namespace ${organization.slug}/`,
          );
        }
        const now = this.#now();
        const item = await repository.createPackage({
          id: this.#nextId(),
          org_id: parsed.org_id,
          name: parsed.name,
          visibility: parsed.visibility,
          created_by: membership.user_id,
          created_at: now,
        });
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: membership.user_id,
          actor_kind: context.actorKind,
          action: "package.created",
          target_type: "package",
          target_id: item.id,
          metadata: { name: item.name, visibility: item.visibility },
          occurred_at: now,
        });
        return mapPackage(item);
      }),
    );
  }

  async listReleases(
    actorUserId: string,
    input: z.input<typeof ListRegistryReleasesInputSchema>,
  ): Promise<RegistryRelease[]> {
    const parsed = ListRegistryReleasesInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        if (parsed.package_name) {
          await this.#requirePackage(
            parsed.org_id,
            parsed.package_name,
            repository,
          );
          const stored = await repository.listReleases(
            parsed.org_id,
            parsed.package_name,
          );
          const mapped = [];
          for (const item of stored) {
            mapped.push(await this.#mapRelease(item, repository));
          }
          return mapped;
        }
        const releases = [];
        for (const item of await repository.listPackages(parsed.org_id)) {
          releases.push(
            ...(await repository.listReleases(parsed.org_id, item.name)),
          );
        }
        const mapped = [];
        for (const item of releases) {
          mapped.push(await this.#mapRelease(item, repository));
        }
        return mapped;
      }),
    );
  }

  async listReleasePage(
    actorUserId: string,
    input: z.input<typeof ListRegistryReleasesPageInputSchema>,
  ): Promise<RegistryPage<RegistryRelease>> {
    const parsed = ListRegistryReleasesPageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        const after = decodeRegistryReleaseCursor(
          parsed.cursor,
          parsed.org_id,
          parsed.package_name,
        );
        const matches = await repository.listReleasePage(parsed.org_id, {
          ...(parsed.package_name === undefined
            ? {}
            : { packageName: parsed.package_name }),
          ...(after === undefined ? {} : { after }),
          limit: parsed.limit + 1,
        });
        const pageItems = matches.slice(0, parsed.limit);
        const items = await this.#mapReleasePage(pageItems, repository);
        const last = items[items.length - 1];
        return {
          items,
          next_cursor:
            matches.length > parsed.limit && last
              ? encodeRegistryReleaseCursor(
                  parsed.org_id,
                  parsed.package_name,
                  { packageName: last.package_name, version: last.version },
                )
              : null,
        };
      }),
    );
  }

  async getRelease(
    actorUserId: string,
    input: z.input<typeof ReviewRegistryReleaseInputSchema>,
  ): Promise<RegistryRelease> {
    const parsed = ReviewRegistryReleaseInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireMember(actorUserId, parsed.org_id, repository);
        return this.#mapRelease(
          await this.#requireRelease(
            parsed.org_id,
            parsed.package_name,
            parsed.version,
            repository,
          ),
          repository,
        );
      }),
    );
  }

  async submitRelease(
    _actorUserId: string,
    _input: z.input<typeof SubmitRegistryReleaseInputSchema>,
  ): Promise<RegistryRelease> {
    throw new RegistryConflictError(
      "Durable Registry releases require a complete verified Pack artifact",
    );
  }

  async submitArtifactRelease(
    actorUserId: string,
    input: z.input<typeof SubmitRegistryReleaseInputSchema>,
    artifactInput: RegistryPackArtifact,
    discoveryInput: PublicPackDiscoveryDocument,
    context: RegistryMutationContext,
  ): Promise<RegistryRelease> {
    const parsed = SubmitRegistryReleaseInputSchema.parse(input);
    const artifact = RegistryPackArtifactSchema.parse(artifactInput);
    const discovery = PublicPackDiscoveryDocumentSchema.parse(discoveryInput);
    if (
      artifact.name !== parsed.package_name ||
      artifact.version !== parsed.version ||
      artifact.integrity !== parsed.artifact.integrity
    ) {
      throw new RegistryConflictError("Pack artifact identity does not match release metadata");
    }
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        const membership = await this.#requireRole(
          actorUserId,
          parsed.org_id,
          WRITER_ROLES,
          repository,
        );
        await this.#requirePackage(
          parsed.org_id,
          parsed.package_name,
          repository,
        );
        const now = this.#now();
        const stored = await repository.createRelease({
          id: this.#nextId(),
          org_id: parsed.org_id,
          package_name: parsed.package_name,
          version: parsed.version,
          artifact_integrity: parsed.artifact.integrity,
          artifact: toJsonObject(artifact),
          manifest: {
            format: artifact.format,
            name: artifact.name,
            version: artifact.version,
            integrity: artifact.integrity,
            digest_hex: artifact.digest_hex,
          },
          provenance: toJsonObject(parsed.artifact.provenance),
          discovery,
          submitted_by: membership.user_id,
          created_at: now,
        });
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: membership.user_id,
          actor_kind: context.actorKind,
          action: "release.submitted",
          target_type: "release",
          target_id: stored.id,
          metadata: {
            package_name: stored.package_name,
            version: stored.version,
          },
          occurred_at: now,
        });
        return this.#mapRelease(stored, repository);
      }),
    );
  }

  async assertArtifactCompatible(
    orgId: string,
    artifactInput: RegistryPackArtifact,
  ): Promise<void> {
    const artifact = RegistryPackArtifactSchema.parse(artifactInput);
    await this.#storage(() =>
      this.#repository.tenantTransaction(orgId, async (repository) => {
      const existing = await repository.getRelease(
        orgId,
        artifact.name,
        artifact.version,
      );
      if (
        existing &&
        serializeRegistryPackArtifact(existing.artifact) !==
          serializeRegistryPackArtifact(artifact)
      ) {
        throw new RegistryStorageConflictError(
          "Registry artifact is immutable and already exists",
        );
      }
      }),
    );
  }

  async getArtifact(
    orgId: string,
    packageName: string,
    version: string,
  ): Promise<RegistryPackArtifact | undefined> {
    return this.#storage(() =>
      this.#repository.tenantTransaction(orgId, async (repository) => {
        const release = await repository.getRelease(orgId, packageName, version);
        return release
          ? RegistryPackArtifactSchema.parse(release.artifact)
          : undefined;
      }),
    );
  }

  async approveRelease(
    actorUserId: string,
    input: z.input<typeof ReviewRegistryReleaseInputSchema>,
  ): Promise<RegistryRelease> {
    return this.approveReleaseWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async approveReleaseWithContext(
    actorUserId: string,
    input: z.input<typeof ReviewRegistryReleaseInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryRelease> {
    const parsed = ReviewRegistryReleaseInputSchema.parse(input);
    assertHumanLifecycleContext(context);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) =>
        this.#mapRelease(
          await repository.approveRelease({
            org_id: parsed.org_id,
            package_name: parsed.package_name,
            version: parsed.version,
            reviewer_user_id: actorUserId,
            request_id: context.requestId,
            approved_at: this.#now(),
          }),
          repository,
        ),
      ),
    );
  }

  async rejectRelease(
    actorUserId: string,
    input: z.input<typeof RejectRegistryReleaseInputSchema>,
  ): Promise<RegistryRelease> {
    return this.rejectReleaseWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async rejectReleaseWithContext(
    actorUserId: string,
    input: z.input<typeof RejectRegistryReleaseInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryRelease> {
    const parsed = RejectRegistryReleaseInputSchema.parse(input);
    assertHumanLifecycleContext(context);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) =>
        this.#mapRelease(
          await repository.rejectRelease({
            org_id: parsed.org_id,
            package_name: parsed.package_name,
            version: parsed.version,
            reviewer_user_id: actorUserId,
            reason: parsed.reason,
            request_id: context.requestId,
            rejected_at: this.#now(),
          }),
          repository,
        ),
      ),
    );
  }

  async yankRelease(
    actorUserId: string,
    input: z.input<typeof YankRegistryReleaseInputSchema>,
  ): Promise<RegistryRelease> {
    return this.yankReleaseWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async yankReleaseWithContext(
    actorUserId: string,
    input: z.input<typeof YankRegistryReleaseInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryRelease> {
    const parsed = YankRegistryReleaseInputSchema.parse(input);
    assertHumanLifecycleContext(context);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) =>
        this.#mapRelease(
          await repository.yankRelease({
            org_id: parsed.org_id,
            package_name: parsed.package_name,
            version: parsed.version,
            reviewer_user_id: actorUserId,
            reason: parsed.reason,
            request_id: context.requestId,
            yanked_at: this.#now(),
          }),
          repository,
        ),
      ),
    );
  }

  async listMembers(
    actorUserId: string,
    input: z.input<typeof RegistryOrganizationIdentityInputSchema>,
  ): Promise<RegistryMember[]> {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireRole(actorUserId, parsed.org_id, ADMIN_ROLES, repository);
        return (await repository.listMembers(parsed.org_id)).map((item) =>
          RegistryMemberSchema.parse({
            org_id: item.org_id,
            user_id: item.user_id,
            role: item.role,
            joined_at: item.created_at,
          }),
        );
      }),
    );
  }

  async listMemberPage(
    actorUserId: string,
    input: z.input<typeof ListRegistryMembersPageInputSchema>,
  ): Promise<RegistryPage<RegistryMember>> {
    const parsed = ListRegistryMembersPageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireRole(
          actorUserId,
          parsed.org_id,
          ADMIN_ROLES,
          repository,
        );
        const afterUserId = decodeRegistryMemberCursor(
          parsed.cursor,
          parsed.org_id,
        );
        const matches = await repository.listMemberPage(parsed.org_id, {
          ...(afterUserId === undefined ? {} : { after: afterUserId }),
          limit: parsed.limit + 1,
        });
        const items = matches.slice(0, parsed.limit).map(mapMember);
        return {
          items,
          next_cursor:
            matches.length > parsed.limit
              ? encodeRegistryMemberCursor(
                  parsed.org_id,
                  items[items.length - 1]!.user_id,
                )
              : null,
        };
      }),
    );
  }

  async addMember(
    actorUserId: string,
    input: z.input<typeof AddRegistryMemberInputSchema>,
  ): Promise<RegistryMember> {
    return this.addMemberWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async addMemberWithContext(
    actorUserId: string,
    input: z.input<typeof AddRegistryMemberInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryMember> {
    const parsed = AddRegistryMemberInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        assertHumanMemberContext(context);
        const organization = await repository.lockOrganization(parsed.org_id);
        if (!organization) {
          throw new RegistryStorageNotFoundError("Registry organization not found");
        }
        const actor = await repository.getMember(parsed.org_id, actorUserId);
        if (!actor || !ADMIN_ROLES.has(actor.role)) {
          throw new RegistryStorageForbiddenError(
            "Member management requires admin or owner membership",
          );
        }
        if (parsed.role === "owner" && actor.role !== "owner") {
          throw new RegistryStorageForbiddenError(
            "Only an owner may grant the owner role",
          );
        }
        if (!(await repository.getUser(parsed.user_id))) {
          throw new RegistryStorageNotFoundError("Registry user not found");
        }
        const maxSeats = await this.#resolveMaxSeats(
          repository,
          parsed.org_id,
          context,
        );
        await this.#assertSeatAvailable(
          repository,
          parsed.org_id,
          parsed.user_id,
          maxSeats,
        );
        const now = this.#now();
        const member = await repository.addMember({
          org_id: parsed.org_id,
          user_id: parsed.user_id,
          role: parsed.role,
          created_at: now,
        });
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: actor.user_id,
          actor_kind: context.actorKind,
          action: "member.added",
          target_type: "member",
          target_id: parsed.user_id,
          metadata: { role: parsed.role },
          occurred_at: now,
        });
        return RegistryMemberSchema.parse({
          org_id: member.org_id,
          user_id: member.user_id,
          role: member.role,
          joined_at: member.created_at,
        });
      }),
    );
  }

  async provisionExternalMemberWithContext(
    actorUserId: string,
    input: z.input<typeof ProvisionExternalRegistryMemberInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryMember> {
    const parsed = ProvisionExternalRegistryMemberInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        assertHumanMemberContext(context);
        const organization = await repository.lockOrganization(parsed.org_id);
        if (!organization) {
          throw new RegistryStorageNotFoundError("Registry organization not found");
        }
        const actor = await repository.getMember(parsed.org_id, actorUserId);
        if (!actor || !ADMIN_ROLES.has(actor.role)) {
          throw new RegistryStorageForbiddenError(
            "Member management requires admin or owner membership",
          );
        }
        if (parsed.role === "owner" && actor.role !== "owner") {
          throw new RegistryStorageForbiddenError(
            "Only an owner may grant the owner role",
          );
        }
        let existingUser = await repository.getUserByExternalIdentity(
          parsed.provider,
          parsed.provider_subject,
        );
        if (existingUser) {
          existingUser = await repository.bindUserIdentityIssuer(
            existingUser.id,
            parsed.identity_issuer,
          );
        }
        if (existingUser?.status === "suspended") {
          throw new RegistryStorageForbiddenError(
            "Suspended Registry users cannot be provisioned",
          );
        }
        const existing = existingUser
          ? await repository.getMember(parsed.org_id, existingUser.id)
          : null;
        if (existing) {
          if (existing.role !== parsed.role) {
            throw new RegistryStorageConflictError(
              "External identity already has a different organization role",
            );
          }
          return mapMember(existing);
        }
        const maxSeats = await this.#resolveMaxSeats(
          repository,
          parsed.org_id,
          context,
        );
        await this.#assertSeatAvailable(
          repository,
          parsed.org_id,
          existingUser?.id,
          maxSeats,
        );
        const now = this.#now();
        const ensured = await repository.ensureUserByExternalIdentity({
          id: this.#nextId(),
          issuer: parsed.provider,
          identity_issuer: parsed.identity_issuer,
          subject: parsed.provider_subject,
          display_name: parsed.display_name,
          created_at: now,
        });
        if (ensured.user.status !== "active") {
          throw new RegistryStorageForbiddenError(
            "Suspended Registry users cannot be provisioned",
          );
        }
        const member = await repository.addMember({
          org_id: parsed.org_id,
          user_id: ensured.user.id,
          role: parsed.role,
          created_at: now,
        });
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: actor.user_id,
          actor_kind: context.actorKind,
          action: "member.added",
          target_type: "member",
          target_id: member.user_id,
          metadata: {
            role: member.role,
            identity_provider: parsed.provider,
            externally_provisioned: true,
          },
          occurred_at: now,
        });
        return mapMember(member);
      }),
    );
  }

  async updateMemberRole(
    actorUserId: string,
    input: z.input<typeof UpdateRegistryMemberInputSchema>,
  ): Promise<RegistryMember> {
    return this.updateMemberRoleWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async updateMemberRoleWithContext(
    actorUserId: string,
    input: z.input<typeof UpdateRegistryMemberInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryMember> {
    const parsed = UpdateRegistryMemberInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        assertHumanMemberContext(context);
        const organization = await repository.lockOrganization(parsed.org_id);
        if (!organization) {
          throw new RegistryStorageNotFoundError("Registry organization not found");
        }
        const actor = await repository.getMember(parsed.org_id, actorUserId);
        if (!actor || !ADMIN_ROLES.has(actor.role)) {
          throw new RegistryStorageForbiddenError(
            "Member management requires admin or owner membership",
          );
        }
        const current = await repository.getMember(parsed.org_id, parsed.user_id);
        if (!current) {
          throw new RegistryStorageNotFoundError("Registry member not found");
        }
        if (
          (current.role === "owner" || parsed.role === "owner") &&
          actor.role !== "owner"
        ) {
          throw new RegistryStorageForbiddenError(
            "Only an owner may manage owner roles",
          );
        }
        if (current.role === parsed.role) {
          throw new RegistryStorageConflictError(
            "Registry member already has this role",
          );
        }
        const owners = (await repository.listMembers(parsed.org_id)).filter(
          (member) => member.role === "owner",
        );
        if (current.role === "owner" && parsed.role !== "owner") {
          const replacement = owners.find(
            (member) => member.user_id !== current.user_id,
          );
          if (!replacement) {
            throw new RegistryStorageConflictError(
              "Organization must retain at least one owner",
            );
          }
          if (organization.owner_user_id === current.user_id) {
            await repository.transferOrganizationOwner(
              parsed.org_id,
              replacement.user_id,
            );
          }
        }
        const now = this.#now();
        const member = await repository.updateMemberRole(
          parsed.org_id,
          parsed.user_id,
          parsed.role,
        );
        const revoked = await repository.revokeApiTokensForSubject(
          parsed.org_id,
          parsed.user_id,
          now,
        );
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: actor.user_id,
          actor_kind: "human",
          action: "member.role_changed",
          target_type: "member",
          target_id: parsed.user_id,
          metadata: {
            previous_role: current.role,
            role: member.role,
            revoked_token_count: revoked.length,
          },
          occurred_at: now,
        });
        return mapMember(member);
      }),
    );
  }

  async removeMember(
    actorUserId: string,
    input: z.input<typeof RemoveRegistryMemberInputSchema>,
  ): Promise<RegistryMember> {
    return this.removeMemberWithContext(actorUserId, input, {
      requestId: randomUUID(),
      actorKind: "human",
    });
  }

  async removeMemberWithContext(
    actorUserId: string,
    input: z.input<typeof RemoveRegistryMemberInputSchema>,
    context: RegistryMutationContext,
  ): Promise<RegistryMember> {
    const parsed = RemoveRegistryMemberInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        assertHumanMemberContext(context);
        const organization = await repository.lockOrganization(parsed.org_id);
        if (!organization) {
          throw new RegistryStorageNotFoundError("Registry organization not found");
        }
        const actor = await repository.getMember(parsed.org_id, actorUserId);
        if (!actor || !ADMIN_ROLES.has(actor.role)) {
          throw new RegistryStorageForbiddenError(
            "Member management requires admin or owner membership",
          );
        }
        const current = await repository.getMember(parsed.org_id, parsed.user_id);
        if (!current) {
          throw new RegistryStorageNotFoundError("Registry member not found");
        }
        if (current.role === "owner" && actor.role !== "owner") {
          throw new RegistryStorageForbiddenError(
            "Only an owner may remove an owner",
          );
        }
        if (current.role === "owner") {
          const replacement = (await repository.listMembers(parsed.org_id)).find(
            (member) =>
              member.role === "owner" && member.user_id !== current.user_id,
          );
          if (!replacement) {
            throw new RegistryStorageConflictError(
              "Organization must retain at least one owner",
            );
          }
          if (organization.owner_user_id === current.user_id) {
            await repository.transferOrganizationOwner(
              parsed.org_id,
              replacement.user_id,
            );
          }
        }
        const now = this.#now();
        const revoked = await repository.revokeApiTokensForSubject(
          parsed.org_id,
          parsed.user_id,
          now,
        );
        const member = await repository.removeMember(
          parsed.org_id,
          parsed.user_id,
        );
        await repository.appendAuditEvent({
          event_id: this.#nextId(),
          request_id: context.requestId,
          org_id: parsed.org_id,
          actor_id: actor.user_id,
          actor_kind: "human",
          action: "member.removed",
          target_type: "member",
          target_id: parsed.user_id,
          metadata: {
            previous_role: current.role,
            reason: parsed.reason,
            revoked_token_count: revoked.length,
          },
          occurred_at: now,
        });
        return mapMember(member);
      }),
    );
  }

  async listAuditEvents(
    actorUserId: string,
    input: { org_id: string },
  ): Promise<readonly RegistryAuditEvent[]> {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
      await this.#requireRole(actorUserId, parsed.org_id, ADMIN_ROLES, repository);
      return (await repository.listAuditEvents(parsed.org_id)).map(mapAuditEvent);
      }),
    );
  }

  async listAuditEventPage(
    actorUserId: string,
    input: z.input<typeof ListRegistryAuditEventsPageInputSchema>,
  ): Promise<RegistryPage<RegistryAuditEvent>> {
    const parsed = ListRegistryAuditEventsPageInputSchema.parse(input);
    return this.#storage(() =>
      this.#repository.tenantTransaction(parsed.org_id, async (repository) => {
        await this.#requireRole(
          actorUserId,
          parsed.org_id,
          ADMIN_ROLES,
          repository,
        );
        const afterSequence = decodeRegistryAuditCursor(
          parsed.cursor,
          parsed.org_id,
        );
        const matches = await repository.listAuditEventPage(parsed.org_id, {
          ...(afterSequence === undefined ? {} : { afterSequence }),
          limit: parsed.limit + 1,
        });
        const items = matches.slice(0, parsed.limit).map(mapAuditEvent);
        return {
          items,
          next_cursor:
            matches.length > parsed.limit
              ? encodeRegistryAuditCursor(
                  parsed.org_id,
                  items[items.length - 1]!.sequence,
                )
              : null,
        };
      }),
    );
  }

  async #requireMember(
    actorUserId: string,
    orgId: string,
    repository = this.#repository,
  ) {
    const member = await repository.getMember(orgId, actorUserId);
    if (!member) throw new RegistryStorageForbiddenError("Organization membership required");
    return member;
  }

  async #resolveMaxSeats(
    repository: PostgresRegistryRepository,
    orgId: string,
    context: RegistryMutationContext,
  ): Promise<number | null | undefined> {
    if (this.#billingMode === "off") return null;
    if (this.#billingMode === "enforced") {
      return entitlementsForPlan(
        await repository.getEffectiveSubscriptionPlan(orgId),
      ).maxSeats;
    }
    return context.maxSeats;
  }

  async #assertSeatAvailable(
    repository: PostgresRegistryRepository,
    orgId: string,
    userId: string | undefined,
    maxSeats: number | null | undefined,
  ): Promise<void> {
    if (maxSeats === undefined || maxSeats === null) return;
    if (!Number.isSafeInteger(maxSeats) || maxSeats < 1) {
      throw new Error("Registry seat limit is invalid");
    }
    if (userId && await repository.getMember(orgId, userId)) return;
    if ((await repository.listMembers(orgId)).length >= maxSeats) {
      throw new RegistrySeatLimitError();
    }
  }

  async #requireRole(
    actorUserId: string,
    orgId: string,
    roles: ReadonlySet<RegistryRole>,
    repository = this.#repository,
  ) {
    const member = await this.#requireMember(actorUserId, orgId, repository);
    if (!roles.has(member.role)) {
      throw new RegistryStorageForbiddenError("Organization role cannot perform this action");
    }
    return member;
  }

  async #requirePackage(
    orgId: string,
    name: string,
    repository = this.#repository,
  ): Promise<StoredRegistryPackage> {
    const item = await repository.getPackage(orgId, name);
    if (!item) throw new RegistryStorageNotFoundError("Registry package not found");
    return item;
  }

  async #requireRelease(
    orgId: string,
    packageName: string,
    version: string,
    repository = this.#repository,
  ): Promise<StoredRegistryRelease> {
    const item = await repository.getRelease(orgId, packageName, version);
    if (!item) throw new RegistryStorageNotFoundError("Registry release not found");
    return item;
  }

  async #mapRelease(
    item: StoredRegistryRelease,
    repository = this.#repository,
  ): Promise<RegistryRelease> {
    const approvals = await repository.listReleaseApprovals(
      item.org_id,
      item.package_name,
      item.version,
    );
    return this.#mapReleaseWithApprovals(item, approvals);
  }

  async #mapReleasePage(
    items: readonly StoredRegistryRelease[],
    repository: PostgresRegistryRepository,
  ): Promise<RegistryRelease[]> {
    if (items.length === 0) return [];
    const approvals = await repository.listReleaseApprovalsByReleaseIds(
      items[0]!.org_id,
      items.map((item) => item.id),
    );
    const byRelease = new Map<string, typeof approvals>();
    for (const approval of approvals) {
      const current = byRelease.get(approval.release_id) ?? [];
      current.push(approval);
      byRelease.set(approval.release_id, current);
    }
    return items.map((item) =>
      this.#mapReleaseWithApprovals(item, byRelease.get(item.id) ?? []),
    );
  }

  #mapReleaseWithApprovals(
    item: StoredRegistryRelease,
    storedApprovals: readonly StoredRegistryReleaseApproval[],
  ): RegistryRelease {
    const approvals = storedApprovals
      .filter((approval) => approval.decision === "approved")
      .map((approval) => ({
        user_id: approval.reviewer_user_id,
        approved_at: approval.created_at,
      }));
    return RegistryReleaseSchema.parse({
      id: item.id,
      org_id: item.org_id,
      package_id: item.package_id,
      package_name: item.package_name,
      version: item.version,
      artifact: RegistryArtifactSchema.parse({
        integrity: item.artifact_integrity,
        provenance: item.provenance,
      }),
      status: item.status,
      approvals,
      submitted_by: item.submitted_by,
      submitted_at: item.created_at,
      published_at: item.published_at,
      rejected_at: item.rejected_at,
      rejection_reason: item.rejection_reason,
      yanked_at: item.yanked_at,
      yank_reason: item.yank_reason,
    });
  }

  #mapPublicRelease(item: StoredRegistryRelease): RegistryPublicRelease {
    if (
      (item.status !== "published" && item.status !== "yanked") ||
      item.approval_count !== 2
    ) {
      throw new Error("Public Registry release approval state is inconsistent");
    }
    return Object.freeze({
      id: item.id,
      org_id: item.org_id,
      package_id: item.package_id,
      package_name: item.package_name,
      version: item.version,
      artifact: RegistryArtifactSchema.parse({
        integrity: item.artifact_integrity,
        provenance: item.provenance,
      }),
      status: item.status,
      approval_count: item.approval_count,
      submitted_by: item.submitted_by,
      submitted_at: item.created_at,
      published_at: item.published_at,
      rejected_at: item.rejected_at,
      rejection_reason: item.rejection_reason,
      yanked_at: item.yanked_at,
      yank_reason: item.yank_reason,
    });
  }

  async #storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RegistryStorageNotFoundError) {
        throw new RegistryNotFoundError(error.message);
      }
      if (error instanceof RegistryStorageForbiddenError) {
        throw new RegistryForbiddenError(error.message);
      }
      if (error instanceof RegistryStorageConflictError) {
        throw new RegistryConflictError(error.message);
      }
      if (error instanceof RegistryStorageTransitionError) {
        throw new RegistryTransitionError(error.message);
      }
      throw error;
    }
  }

  #nextId(): string {
    return z.string().uuid().parse(this.#idFactory());
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Registry clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

function mapPackage(item: StoredRegistryPackage): RegistryPackage {
  return RegistryPackageSchema.parse({
    id: item.id,
    org_id: item.org_id,
    name: item.name,
    visibility: item.visibility,
    created_by: item.created_by,
    created_at: item.created_at,
  });
}

function mapPublicPackageSearchHit(
  item: StoredPublicRegistryPackageSearchHit,
): PublicRegistryPackageSearchHit {
  return PublicRegistryPackageSearchHitSchema.parse({
    ...mapPackage(item),
    latest_version: item.latest_version,
    discovery_available: item.discovery_available,
    discovery: item.discovery,
  });
}

function mapMember(item: {
  org_id: string;
  user_id: string;
  role: RegistryRole;
  created_at: string;
}): RegistryMember {
  return RegistryMemberSchema.parse({
    org_id: item.org_id,
    user_id: item.user_id,
    role: item.role,
    joined_at: item.created_at,
  });
}

function mapAuditEvent(event: StoredRegistryAuditEvent): RegistryAuditEvent {
  return RegistryAuditEventSchema.parse({
    sequence: event.sequence,
    id: event.event_id,
    request_id: event.request_id,
    org_id: event.org_id,
    actor_user_id: event.actor_id,
    actor_kind: event.actor_kind,
    action: event.action,
    subject_type: event.target_type,
    subject_id: event.target_id,
    metadata: event.metadata,
    occurred_at: event.occurred_at,
  });
}

function toJsonObject(value: unknown): RegistryJsonObject {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Registry JSON payload must be an object");
  }
  return parsed as RegistryJsonObject;
}

function assertHumanLifecycleContext(context: RegistryMutationContext): void {
  if (context.actorKind !== "human") {
    throw new RegistryForbiddenError(
      "Release lifecycle decisions require a verified human actor",
    );
  }
}

function assertHumanMemberContext(context: RegistryMutationContext): void {
  if (context.actorKind !== "human") {
    throw new RegistryForbiddenError(
      "Organization membership changes require a verified human actor",
    );
  }
}
