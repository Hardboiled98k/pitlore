import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  RegistryPackArtifactSchema,
  createRegistryPackArtifact,
  withMaterializedRegistryPackArtifact,
  type RegistryPackArtifact,
} from "./registry-artifact.js";
import {
  MAX_PUBLIC_REGISTRY_CURSOR_LENGTH,
  MAX_PUBLIC_REGISTRY_PAGE_SIZE,
  RegistryAuditEventSchema,
  RegistryArtifactSchema,
  RegistryMemberSchema,
  RegistryPackageSchema,
  RegistryReleaseSchema,
  RegistryRoleSchema,
  type RegistryAuditEvent,
  type RegistryMember,
  type RegistryPackage,
  type RegistryRelease,
  type RegistryRole,
} from "./registry-domain.js";
import {
  REGISTRY_PERMISSIONS,
  type RegistryPermission,
} from "./registry-auth.js";
import {
  PublicPackDiscoveryDocumentSchema,
  normalizePublicPackDiscoveryFilter,
} from "./registry-search.js";
import {
  installRegistryPack,
  verifyInstalledPacks,
  type InstalledPack,
} from "./pack.js";
import { PackNameSchema, SemverSchema } from "./schema.js";
import { refineUsageEventSemantics } from "./registry-telemetry.js";
import { isRegistryBearerToken } from "./registry-protocol.js";
import {
  MAX_PACK_SEMANTIC_DIFF_BYTES,
  PackSemanticDiffSchema,
  type PackSemanticDiff,
} from "./pack-semantic-diff.js";

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_REGISTRY_RESPONSE_BYTES = 35 * 1024 * 1024;
/** Diff JSON is capped at 128 KiB; reserve 1 KiB for the success envelope. */
export const MAX_SEMANTIC_DIFF_RESPONSE_BYTES =
  MAX_PACK_SEMANTIC_DIFF_BYTES + 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const RegistryEnvelopeSchema = z
  .object({ data: z.unknown(), request_id: z.string().min(1).max(256) })
  .strict();
const RegistryErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(1_000),
        request_id: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();
const RegistryReleaseStateSchema = z
  .object({
    package_name: PackNameSchema,
    version: SemverSchema,
    artifact: RegistryArtifactSchema,
    status: z.enum(["pending", "published", "rejected", "yanked"]),
    yank_reason: z.string().nullable().optional(),
  })
  .passthrough();
const RegistryPublicPackageSchema = z
  .object({
    name: PackNameSchema,
    visibility: z.literal("public"),
    created_at: z.string().datetime(),
  })
  .strict();
const RegistryPublicPackageWithFacetsSchema = RegistryPublicPackageSchema.extend({
  latest_version: SemverSchema.nullable(),
  discovery_available: z.boolean(),
  description: PublicPackDiscoveryDocumentSchema.shape.description,
  lesson_count: PublicPackDiscoveryDocumentSchema.shape.lesson_count,
  facets: z
    .object({
      languages: PublicPackDiscoveryDocumentSchema.shape.languages,
      ecosystems: PublicPackDiscoveryDocumentSchema.shape.ecosystems,
      tags: PublicPackDiscoveryDocumentSchema.shape.tags,
    })
    .strict(),
})
  .strict()
  .superRefine((value, context) => {
    if (
      !value.discovery_available &&
      (value.description !== "" ||
        value.lesson_count !== 0 ||
        value.facets.languages.length !== 0 ||
        value.facets.ecosystems.length !== 0 ||
        value.facets.tags.length !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unavailable discovery metadata must be empty",
      });
    }
    if (value.discovery_available && value.latest_version === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latest_version"],
        message: "Available discovery metadata requires a published release",
      });
    }
  });
const RegistryPublicPageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_PUBLIC_REGISTRY_PAGE_SIZE).optional(),
    cursor: z
      .string()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
      .optional(),
  })
  .strict();
const RegistryPublicPackageSearchOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_PUBLIC_REGISTRY_PAGE_SIZE).optional(),
    cursor: z
      .string()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
      .optional(),
    languages: z.array(z.string().max(256)).max(4).default([]),
    ecosystems: z.array(z.string().max(256)).max(4).default([]),
    tags: z.array(z.string().max(256)).max(4).default([]),
    includeFacets: z.boolean().default(false),
  })
  .strict()
  .transform((input, context) => {
    try {
      return {
        ...input,
        ...normalizePublicPackDiscoveryFilter({
          languages: input.languages,
          ecosystems: input.ecosystems,
          tags: input.tags,
        }),
      };
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
const RegistryPublicPackagePageSchema = z
  .object({
    packages: z.array(RegistryPublicPackageSchema),
    next_cursor: z
      .string()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
      .nullable()
      .optional(),
  })
  .strict();
const RegistryPublicPackageWithFacetsPageSchema = z
  .object({
    packages: z.array(RegistryPublicPackageWithFacetsSchema),
    next_cursor: z
      .string()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
      .nullable()
      .optional(),
  })
  .strict();
const RegistryPublicReleasePageSchema = z
  .object({
    releases: z.array(RegistryReleaseStateSchema),
    next_cursor: z
      .string()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
      .nullable()
      .optional(),
  })
  .strict();
const RegistryNextCursorSchema = z
  .string()
  .min(1)
  .max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH)
  .nullable()
  .optional();
const RegistryApiTokenViewSchema = z
  .object({
    token_id: z.string().uuid(),
    prefix: z.string().min(1).max(128),
    scopes: z.array(z.enum(REGISTRY_PERMISSIONS)),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
  })
  .strict();
const RegistryTokenPageSchema = z
  .object({
    tokens: z.array(RegistryApiTokenViewSchema),
    next_cursor: RegistryNextCursorSchema,
  })
  .strict();
const RegistryPackagePageSchema = z
  .object({
    packages: z.array(RegistryPackageSchema),
    next_cursor: RegistryNextCursorSchema,
  })
  .strict();
const RegistryReleasePageSchema = z
  .object({
    releases: z.array(RegistryReleaseSchema),
    next_cursor: RegistryNextCursorSchema,
  })
  .strict();
const RegistryMemberPageSchema = z
  .object({
    members: z.array(RegistryMemberSchema),
    next_cursor: RegistryNextCursorSchema,
  })
  .strict();
const RegistryAuditEventPageSchema = z
  .object({
    events: z.array(RegistryAuditEventSchema),
    next_cursor: RegistryNextCursorSchema,
  })
  .strict();

export type RegistryReleaseState = z.infer<typeof RegistryReleaseStateSchema>;
export type RegistryPublicPackage = z.infer<typeof RegistryPublicPackageSchema>;
export type RegistryPublicPackageWithFacets = z.infer<
  typeof RegistryPublicPackageWithFacetsSchema
>;

export interface RegistryPublicPageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RegistryPublicPackageSearchOptions
  extends RegistryPublicPageOptions {
  readonly languages?: readonly string[];
  readonly ecosystems?: readonly string[];
  readonly tags?: readonly string[];
  readonly includeFacets?: boolean;
}

export type RegistryPageOptions = RegistryPublicPageOptions;

export interface RegistryReleasePageOptions extends RegistryPageOptions {
  readonly packageName?: string;
}

export interface RegistryApiTokenView {
  readonly token_id: string;
  readonly prefix: string;
  readonly scopes: readonly RegistryPermission[];
  readonly created_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

export interface RegistryTokenPage {
  readonly tokens: readonly RegistryApiTokenView[];
  readonly next_cursor: string | null;
}

export interface RegistryPackagePage {
  readonly packages: readonly RegistryPackage[];
  readonly next_cursor: string | null;
}

export interface RegistryReleasePage {
  readonly releases: readonly RegistryRelease[];
  readonly next_cursor: string | null;
}

export interface RegistryMemberPage {
  readonly members: readonly RegistryMember[];
  readonly next_cursor: string | null;
}

export interface RegistryAuditEventPage {
  readonly events: readonly RegistryAuditEvent[];
  readonly next_cursor: string | null;
}

export interface RegistryPublicPackagePage {
  readonly packages: readonly (
    | RegistryPublicPackage
    | RegistryPublicPackageWithFacets
  )[];
  readonly next_cursor: string | null;
}

export interface RegistryPublicReleasePage {
  readonly releases: readonly RegistryReleaseState[];
  readonly next_cursor: string | null;
}

export interface RegistryHttpClientOptions {
  baseUrl: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface RegistryPublishOptions {
  orgId: string;
  sourceUrl: string;
  sourceCommit: string;
}

export interface RegistryExternalMemberInput {
  readonly orgId: string;
  readonly providerSubject: string;
  readonly displayName: string;
  readonly role: RegistryRole;
}

export interface RegistryInstallOptions {
  loreRoot: string;
  orgId?: string;
  trustedKeyIds?: string[];
  reportUsage?: boolean;
}

export interface RegistryInstallResult extends InstalledPack {
  usageReported: boolean;
  usageReportError: string | null;
}

export interface RegistryUsageReportInput {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly kind: "install" | "retrieve" | "check" | "false_positive";
  readonly packageName: string;
  readonly packageVersion: string;
  readonly lessonId?: string | null;
  readonly outcome?: "hit" | "clean" | "used" | "irrelevant" | null;
}

const RegistryUsageReportInputSchema = z
  .object({
    eventId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
    occurredAt: z.string().datetime(),
    kind: z.enum(["install", "retrieve", "check", "false_positive"]),
    packageName: PackNameSchema,
    packageVersion: SemverSchema,
    lessonId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .nullable()
      .default(null),
    outcome: z
      .enum(["hit", "clean", "used", "irrelevant"])
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((input, context) => {
    refineUsageEventSemantics(
      {
        kind: input.kind,
        lesson_id: input.lessonId,
        outcome: input.outcome,
      },
      context,
    );
  });

export interface RegistryRevalidationResult {
  readonly registryUrl: string;
  readonly checked: number;
  readonly current: readonly string[];
  readonly yanked: ReadonlyArray<{
    reference: string;
    reason: string | null;
  }>;
}

export class RegistryClientError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly code: string,
    readonly requestId: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RegistryClientError";
  }
}

export class RegistryHttpClient {
  readonly #baseUrl: URL;
  readonly #bearerToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: RegistryHttpClientOptions) {
    this.#baseUrl = validateRegistryBaseUrl(options.baseUrl);
    if (
      options.bearerToken !== undefined &&
      !isRegistryBearerToken(options.bearerToken)
    ) {
      throw new Error("Registry bearer token format is invalid");
    }
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.#baseUrl.toString();
  }

  async searchPublicPackages(
    query = "",
    options: RegistryPublicPackageSearchOptions = {},
  ): Promise<RegistryPublicPackagePage> {
    if (query.length > 128) throw new Error("Registry search query is too long");
    const parsedOptions = RegistryPublicPackageSearchOptionsSchema.parse(options);
    const payload = await this.#request(
      `v1/public/packages?${publicPackageSearchQuery(query, parsedOptions)}`,
      { authenticated: false },
    );
    const result = parsedOptions.includeFacets
      ? RegistryPublicPackageWithFacetsPageSchema.parse(payload)
      : RegistryPublicPackagePageSchema.parse(payload);
    return {
      packages: result.packages,
      next_cursor: result.next_cursor ?? null,
    };
  }

  async listPublicReleasePage(
    packageName: string,
    options: RegistryPublicPageOptions = {},
  ): Promise<RegistryPublicReleasePage> {
    const name = PackNameSchema.parse(packageName);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse(options);
    const result = RegistryPublicReleasePageSchema.parse(
      await this.#request(
        `v1/public/releases?${publicPageQuery(
          { package_name: name },
          parsedOptions,
        )}`,
        { authenticated: false },
      ),
    );
    return {
      releases: result.releases,
      next_cursor: result.next_cursor ?? null,
    };
  }

  async listPublicReleases(packageName: string): Promise<readonly RegistryReleaseState[]> {
    const name = PackNameSchema.parse(packageName);
    const releases: RegistryReleaseState[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      // Keep the first request compatible with pre-pagination Registry servers,
      // whose strict query parser accepts package_name only.
      const page = await this.listPublicReleasePage(
        name,
        cursor === undefined ? {} : { cursor },
      );
      releases.push(...page.releases);
      if (page.next_cursor === null) return releases;
      if (seenCursors.has(page.next_cursor)) {
        throw new RegistryClientError(
          "Registry returned a repeated pagination cursor",
          null,
          "invalid_pagination",
          null,
        );
      }
      seenCursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    throw new RegistryClientError(
      "Registry pagination exceeded the client safety limit",
      null,
      "pagination_limit",
      null,
    );
  }

  async diffPublicReleases(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<PackSemanticDiff> {
    const name = PackNameSchema.parse(packageName);
    const from = SemverSchema.parse(fromVersion);
    const to = SemverSchema.parse(toVersion);
    if (from === to) {
      throw new Error("Registry diff versions must be different");
    }
    const query = new URLSearchParams({
      package_name: name,
      from_version: from,
      to_version: to,
    });
    const parsedDiff = PackSemanticDiffSchema.safeParse(
      await this.#request(`v1/public/diff?${query.toString()}`, {
        authenticated: false,
        maxResponseBytes: MAX_SEMANTIC_DIFF_RESPONSE_BYTES,
      }),
    );
    if (!parsedDiff.success) {
      throw new RegistryClientError(
        "Registry returned an invalid semantic diff",
        null,
        "invalid_response",
        null,
      );
    }
    const diff = parsedDiff.data;
    if (
      diff.pack_name !== name ||
      diff.from.version !== from ||
      diff.to.version !== to
    ) {
      throw new RegistryClientError(
        "Registry semantic diff did not match the requested Pack versions",
        null,
        "invalid_response",
        null,
      );
    }
    return diff;
  }

  async listTokenPage(
    orgId: string,
    options: RegistryPageOptions = {},
  ): Promise<RegistryTokenPage> {
    const organizationId = z.string().uuid().parse(orgId);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse(options);
    const result = RegistryTokenPageSchema.parse(
      await this.#request(
        organizationPageEndpoint(organizationId, "tokens", {}, parsedOptions),
        { authenticated: true },
      ),
    );
    return { tokens: result.tokens, next_cursor: result.next_cursor ?? null };
  }

  async listTokens(orgId: string): Promise<readonly RegistryApiTokenView[]> {
    return this.#collectPages(
      async (cursor) => {
        const page = await this.listTokenPage(
          orgId,
          cursor === undefined ? {} : { cursor },
        );
        return { items: page.tokens, next_cursor: page.next_cursor };
      },
    );
  }

  async listPackagePage(
    orgId: string,
    options: RegistryPageOptions = {},
  ): Promise<RegistryPackagePage> {
    const organizationId = z.string().uuid().parse(orgId);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse(options);
    const result = RegistryPackagePageSchema.parse(
      await this.#request(
        organizationPageEndpoint(organizationId, "packages", {}, parsedOptions),
        { authenticated: true },
      ),
    );
    return {
      packages: result.packages,
      next_cursor: result.next_cursor ?? null,
    };
  }

  async listPackages(orgId: string): Promise<readonly RegistryPackage[]> {
    return this.#collectPages(
      async (cursor) => {
        const page = await this.listPackagePage(
          orgId,
          cursor === undefined ? {} : { cursor },
        );
        return { items: page.packages, next_cursor: page.next_cursor };
      },
    );
  }

  async listReleasePage(
    orgId: string,
    options: RegistryReleasePageOptions = {},
  ): Promise<RegistryReleasePage> {
    const organizationId = z.string().uuid().parse(orgId);
    const packageName = options.packageName === undefined
      ? undefined
      : PackNameSchema.parse(options.packageName);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse({
      limit: options.limit,
      cursor: options.cursor,
    });
    const result = RegistryReleasePageSchema.parse(
      await this.#request(
        organizationPageEndpoint(
          organizationId,
          "releases",
          packageName === undefined ? {} : { package_name: packageName },
          parsedOptions,
        ),
        { authenticated: true },
      ),
    );
    return {
      releases: result.releases,
      next_cursor: result.next_cursor ?? null,
    };
  }

  async listReleases(
    orgId: string,
    packageName?: string,
  ): Promise<readonly RegistryRelease[]> {
    return this.#collectPages(
      async (cursor) => {
        const page = await this.listReleasePage(orgId, {
          ...(packageName === undefined ? {} : { packageName }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { items: page.releases, next_cursor: page.next_cursor };
      },
    );
  }

  async listMemberPage(
    orgId: string,
    options: RegistryPageOptions = {},
  ): Promise<RegistryMemberPage> {
    const organizationId = z.string().uuid().parse(orgId);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse(options);
    const result = RegistryMemberPageSchema.parse(
      await this.#request(
        organizationPageEndpoint(organizationId, "members", {}, parsedOptions),
        { authenticated: true },
      ),
    );
    return { members: result.members, next_cursor: result.next_cursor ?? null };
  }

  async listMembers(orgId: string): Promise<readonly RegistryMember[]> {
    return this.#collectPages(
      async (cursor) => {
        const page = await this.listMemberPage(
          orgId,
          cursor === undefined ? {} : { cursor },
        );
        return { items: page.members, next_cursor: page.next_cursor };
      },
    );
  }

  async listAuditEventPage(
    orgId: string,
    options: RegistryPageOptions = {},
  ): Promise<RegistryAuditEventPage> {
    const organizationId = z.string().uuid().parse(orgId);
    const parsedOptions = RegistryPublicPageOptionsSchema.parse(options);
    const result = RegistryAuditEventPageSchema.parse(
      await this.#request(
        organizationPageEndpoint(organizationId, "audit", {}, parsedOptions),
        { authenticated: true },
      ),
    );
    return { events: result.events, next_cursor: result.next_cursor ?? null };
  }

  async listAuditEvents(orgId: string): Promise<readonly RegistryAuditEvent[]> {
    return this.#collectPages(
      async (cursor) => {
        const page = await this.listAuditEventPage(
          orgId,
          cursor === undefined ? {} : { cursor },
        );
        return { items: page.events, next_cursor: page.next_cursor };
      },
    );
  }

  async getRelease(
    reference: string,
    orgId?: string,
  ): Promise<RegistryReleaseState> {
    const parsed = parsePackReference(reference);
    const query = `package_name=${encodeURIComponent(parsed.name)}&version=${encodeURIComponent(parsed.version)}`;
    const endpoint = orgId
      ? `v1/orgs/${encodeURIComponent(z.string().uuid().parse(orgId))}/release?${query}`
      : `v1/public/release?${query}`;
    return RegistryReleaseStateSchema.parse(
      await this.#request(endpoint, { authenticated: orgId !== undefined }),
    );
  }

  async createPackage(input: {
    orgId: string;
    name: string;
    visibility: "public" | "private";
  }): Promise<unknown> {
    z.string().uuid().parse(input.orgId);
    return this.#request(`v1/orgs/${encodeURIComponent(input.orgId)}/packages`, {
      authenticated: true,
      method: "POST",
      body: {
        name: PackNameSchema.parse(input.name),
        visibility: z.enum(["public", "private"]).parse(input.visibility),
      },
    });
  }

  async provisionExternalMember(
    input: RegistryExternalMemberInput,
  ): Promise<RegistryMember> {
    const orgId = z.string().uuid().parse(input.orgId);
    const providerSubject = z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
      )
      .parse(input.providerSubject);
    const displayName = z.string().trim().min(1).max(120).parse(input.displayName);
    return RegistryMemberSchema.parse(
      await this.#request(
        `v1/orgs/${encodeURIComponent(orgId)}/members/provision`,
        {
          authenticated: true,
          method: "POST",
          body: {
            provider_subject: providerSubject,
            display_name: displayName,
            role: RegistryRoleSchema.parse(input.role),
          },
        },
      ),
    );
  }

  async publishPack(
    packRoot: string,
    options: RegistryPublishOptions,
  ): Promise<unknown> {
    z.string().uuid().parse(options.orgId);
    const packArtifact = createRegistryPackArtifact(packRoot);
    const artifact = RegistryArtifactSchema.parse({
      integrity: packArtifact.integrity,
      provenance: {
        source_type: "git",
        source_url: options.sourceUrl,
        source_commit: options.sourceCommit,
      },
    });
    return this.#request(
      `v1/orgs/${encodeURIComponent(options.orgId)}/releases`,
      {
        authenticated: true,
        method: "POST",
        body: {
          package_name: packArtifact.name,
          version: packArtifact.version,
          artifact,
          pack_artifact: packArtifact,
        },
      },
    );
  }

  async approveRelease(
    orgId: string,
    reference: string,
  ): Promise<unknown> {
    return this.#reviewRelease(orgId, reference, "approve");
  }

  async rejectRelease(
    orgId: string,
    reference: string,
    reason: string,
  ): Promise<unknown> {
    if (reason.trim().length === 0 || reason.length > 1_000) {
      throw new Error("Registry rejection reason must contain 1 to 1000 characters");
    }
    return this.#reviewRelease(orgId, reference, "reject", reason.trim());
  }

  async yankRelease(
    orgId: string,
    reference: string,
    reason: string,
  ): Promise<unknown> {
    if (reason.trim().length === 0 || reason.length > 1_000) {
      throw new Error("Registry yank reason must contain 1 to 1000 characters");
    }
    return this.#reviewRelease(orgId, reference, "yank", reason.trim());
  }

  async downloadArtifact(
    reference: string,
    orgId?: string,
  ): Promise<RegistryPackArtifact> {
    const parsed = parsePackReference(reference);
    const query = `package_name=${encodeURIComponent(parsed.name)}&version=${encodeURIComponent(parsed.version)}`;
    const endpoint = orgId
      ? `v1/orgs/${encodeURIComponent(z.string().uuid().parse(orgId))}/artifact?${query}`
      : `v1/public/artifact?${query}`;
    return RegistryPackArtifactSchema.parse(
      await this.#request(endpoint, { authenticated: orgId !== undefined }),
    );
  }

  async installPack(
    reference: string,
    options: RegistryInstallOptions,
  ): Promise<RegistryInstallResult> {
    const artifact = await this.downloadArtifact(reference, options.orgId);
    const installed = withMaterializedRegistryPackArtifact(artifact, (verified) =>
      installRegistryPack(verified.root, {
        loreRoot: options.loreRoot,
        registryUrl: this.baseUrl,
        orgId: options.orgId ?? null,
        trustedKeyIds: options.trustedKeyIds ?? [],
      }),
    );
    let usageReported = false;
    let usageReportError: string | null = null;
    if (options.reportUsage === true) {
      if (!options.orgId) {
        usageReportError = "Install reporting requires an authenticated organization";
      } else {
        try {
          await this.#request(
            `v1/orgs/${encodeURIComponent(options.orgId)}/usage/events`,
            {
              authenticated: true,
              method: "POST",
              body: {
                event_id: `install:${randomUUID()}`,
                occurred_at: new Date().toISOString(),
                kind: "install",
                consent: "client-opt-in",
                package_name: artifact.name,
                package_version: artifact.version,
                lesson_id: null,
                outcome: null,
              },
            },
          );
          usageReported = true;
        } catch (error) {
          usageReportError =
            error instanceof RegistryClientError
              ? `${error.code}${error.requestId ? ` (${error.requestId})` : ""}`
              : "usage_report_failed";
        }
      }
    }
    return { ...installed, usageReported, usageReportError };
  }

  async reportUsage(
    orgId: string,
    input: RegistryUsageReportInput,
  ): Promise<unknown> {
    const organizationId = z.string().uuid().parse(orgId);
    const parsed = RegistryUsageReportInputSchema.parse(input);
    return this.#request(
      `v1/orgs/${encodeURIComponent(organizationId)}/usage/events`,
      {
        authenticated: true,
        method: "POST",
        body: {
          event_id: parsed.eventId,
          occurred_at: parsed.occurredAt,
          kind: parsed.kind,
          consent: "client-opt-in",
          package_name: parsed.packageName,
          package_version: parsed.packageVersion,
          lesson_id: parsed.lessonId,
          outcome: parsed.outcome,
        },
      },
    );
  }

  async revalidateInstalledPacks(
    loreRoot: string,
  ): Promise<RegistryRevalidationResult> {
    const lock = verifyInstalledPacks(loreRoot);
    const entries = Object.entries(lock.packages).filter(
      (entry): entry is [string, (typeof lock.packages)[string]] =>
        entry[1].source.type === "registry" &&
        entry[1].source.url === this.baseUrl,
    );
    const current: string[] = [];
    const yanked: Array<{ reference: string; reason: string | null }> = [];
    for (const [name, entry] of entries) {
      if (entry.source.type !== "registry") continue;
      const reference = `${name}@${entry.version}`;
      const release = await this.getRelease(
        reference,
        entry.source.org_id ?? undefined,
      );
      if (release.artifact.integrity !== entry.integrity) {
        throw new RegistryClientError(
          `Registry release integrity no longer matches the lock for ${reference}`,
          null,
          "integrity_mismatch",
          null,
        );
      }
      if (release.status === "yanked") {
        yanked.push({ reference, reason: release.yank_reason ?? null });
        continue;
      }
      if (release.status !== "published") {
        throw new RegistryClientError(
          `Registry release is no longer published: ${reference}`,
          null,
          "release_unavailable",
          null,
        );
      }
      current.push(reference);
    }
    return Object.freeze({
      registryUrl: this.baseUrl,
      checked: entries.length,
      current: Object.freeze(current),
      yanked: Object.freeze(yanked.map((item) => Object.freeze(item))),
    });
  }

  async #collectPages<T>(
    loadPage: (
      cursor: string | undefined,
    ) => Promise<{ readonly items: readonly T[]; readonly next_cursor: string | null }>,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      const page = await loadPage(cursor);
      items.push(...page.items);
      if (page.next_cursor === null) return items;
      if (seenCursors.has(page.next_cursor)) {
        throw new RegistryClientError(
          "Registry returned a repeated pagination cursor",
          null,
          "invalid_pagination",
          null,
        );
      }
      seenCursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    throw new RegistryClientError(
      "Registry pagination exceeded the client safety limit",
      null,
      "pagination_limit",
      null,
    );
  }

  async #reviewRelease(
    orgId: string,
    reference: string,
    action: "approve" | "reject" | "yank",
    reason?: string,
  ): Promise<unknown> {
    z.string().uuid().parse(orgId);
    const parsed = parsePackReference(reference);
    return this.#request(
      `v1/orgs/${encodeURIComponent(orgId)}/releases/${action}`,
      {
        authenticated: true,
        method: "POST",
        body: {
          package_name: parsed.name,
          version: parsed.version,
          ...(reason === undefined ? {} : { reason }),
        },
      },
    );
  }

  async #request(
    endpoint: string,
    options: {
      authenticated: boolean;
      method?: "GET" | "POST";
      body?: unknown;
      maxResponseBytes?: number;
    },
  ): Promise<unknown> {
    if (options.authenticated && !this.#bearerToken) {
      throw new RegistryClientError(
        "Registry authentication is required",
        null,
        "authentication_required",
        null,
      );
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.authenticated) {
      headers.authorization = `Bearer ${this.#bearerToken}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.#fetch(new URL(endpoint, this.#baseUrl), {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RegistryClientError(
        "Registry request failed before a response was received",
        null,
        "network_error",
        null,
        { cause: error },
      );
    }
    const maxResponseBytes =
      options.maxResponseBytes ?? MAX_REGISTRY_RESPONSE_BYTES;
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxResponseBytes
    ) {
      if (response.body) {
        try {
          await response.body.cancel("Registry response exceeded the client size limit");
        } catch {
          // The size violation is authoritative even if transport cleanup fails.
        }
      }
      throw new RegistryClientError(
        "Registry response exceeded the client size limit",
        response.status,
        "response_too_large",
        null,
      );
    }
    const raw = await readBoundedResponseText(response, maxResponseBytes);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new RegistryClientError(
        "Registry returned an invalid JSON response",
        response.status,
        "invalid_response",
        null,
      );
    }
    if (!response.ok) {
      const failure = RegistryErrorEnvelopeSchema.safeParse(json);
      throw new RegistryClientError(
        failure.success ? failure.data.error.message : "Registry request was rejected",
        response.status,
        failure.success ? failure.data.error.code : "request_rejected",
        failure.success ? failure.data.error.request_id : null,
      );
    }
    const envelope = RegistryEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new RegistryClientError(
        "Registry returned an invalid success envelope",
        response.status,
        "invalid_response",
        null,
      );
    }
    return envelope.data.data;
  }
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        void reader
          .cancel("Registry response exceeded the client size limit")
          .catch(() => undefined);
        throw new RegistryClientError(
          "Registry response exceeded the client size limit",
          response.status,
          "response_too_large",
          null,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RegistryClientError) throw error;
    throw new RegistryClientError(
      "Registry response stream failed",
      response.status,
      "network_error",
      null,
      { cause: error },
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed best-effort cancellation must not mask the bounded read result.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString(
    "utf8",
  );
}

function publicPageQuery(
  required: Readonly<Record<string, string>>,
  options: RegistryPublicPageOptions,
): string {
  const query = new URLSearchParams(required);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  return query.toString();
}

function publicPackageSearchQuery(
  queryText: string,
  options: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly languages: readonly string[];
    readonly ecosystems: readonly string[];
    readonly tags: readonly string[];
    readonly includeFacets: boolean;
  },
): string {
  const query = new URLSearchParams({ query: queryText });
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  for (const language of options.languages) query.append("language", language);
  for (const ecosystem of options.ecosystems) {
    query.append("ecosystem", ecosystem);
  }
  for (const tag of options.tags) query.append("tag", tag);
  if (options.includeFacets) query.set("include", "facets");
  return query.toString();
}

function organizationPageEndpoint(
  orgId: string,
  collection: "tokens" | "packages" | "releases" | "members" | "audit",
  required: Readonly<Record<string, string>>,
  options: RegistryPublicPageOptions,
): string {
  const query = publicPageQuery(required, options);
  const path = `v1/orgs/${encodeURIComponent(orgId)}/${collection}`;
  return query.length === 0 ? path : `${path}?${query}`;
}

export function parsePackReference(reference: string): {
  name: string;
  version: string;
} {
  const separator = reference.lastIndexOf("@");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error("Registry Pack reference must use name@exact-version");
  }
  return {
    name: PackNameSchema.parse(reference.slice(0, separator)),
    version: SemverSchema.parse(reference.slice(separator + 1)),
  };
}

function validateRegistryBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Registry URL must be absolute");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Registry URL must use credential-free HTTPS (or loopback HTTP) without query or fragment",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new Error("Registry timeout must be between 100 and 120000 milliseconds");
  }
  return value;
}
