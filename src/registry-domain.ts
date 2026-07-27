import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import semver from "semver";
import { z } from "zod";
import {
  PublicPackDiscoveryDocumentSchema,
  emptyPublicPackDiscoveryDocument,
  matchesPublicPackDiscoveryFilter,
  normalizePublicPackDiscoveryFilter,
  type PublicPackDiscoveryDocument,
  type PublicPackDiscoveryFilterInput,
} from "./registry-search.js";
import { PackNameSchema, SemverSchema } from "./schema.js";

const RegistryIdSchema = z.string().uuid();
const RegistryTimestampSchema = z.string().datetime();
const RegistrySlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    "organization slug must be lowercase kebab-case",
  );
const RegistryDisplayNameSchema = z.string().trim().min(1).max(120);
const RegistryReasonSchema = z.string().trim().min(1).max(1_000);
const Sha256IntegritySchema = z
  .string()
  .regex(/^sha256-[A-Za-z0-9+/]{43}=$/, "integrity must be sha256 base64");

export const DEFAULT_REGISTRY_PAGE_SIZE = 50;
export const MAX_REGISTRY_PAGE_SIZE = 100;
export const MAX_REGISTRY_CURSOR_LENGTH = 1_024;

// Compatibility exports retained for public Registry consumers.
export const DEFAULT_PUBLIC_REGISTRY_PAGE_SIZE = DEFAULT_REGISTRY_PAGE_SIZE;
export const MAX_PUBLIC_REGISTRY_PAGE_SIZE = MAX_REGISTRY_PAGE_SIZE;
export const MAX_PUBLIC_REGISTRY_CURSOR_LENGTH = MAX_REGISTRY_CURSOR_LENGTH;

const RegistryPageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_REGISTRY_PAGE_SIZE)
  .default(DEFAULT_REGISTRY_PAGE_SIZE);
const RegistryCursorTextSchema = z
  .string()
  .min(1)
  .max(MAX_REGISTRY_CURSOR_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "cursor must be canonical base64url");
const LegacyPublicRegistryPackageCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("packages"),
    query: z.string().max(128),
    after_name: PackNameSchema,
  })
  .strict();
const PublicRegistryPackageCursorSchema = z
  .object({
    v: z.literal(2),
    kind: z.literal("packages"),
    request_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    after_name: PackNameSchema,
  })
  .strict();
const PublicRegistryPackageCursorDocumentSchema = z.union([
  LegacyPublicRegistryPackageCursorSchema,
  PublicRegistryPackageCursorSchema,
]);
const PublicRegistryReleaseCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("releases"),
    package_name: PackNameSchema,
    after_version: SemverSchema,
  })
  .strict();

const RegistryTokenCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("tokens"),
    org_id: RegistryIdSchema,
    after_created_at: RegistryTimestampSchema,
    after_id: RegistryIdSchema,
  })
  .strict();
const RegistryPackageCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("org_packages"),
    org_id: RegistryIdSchema,
    after_name: PackNameSchema,
  })
  .strict();
const RegistryReleaseCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("org_releases"),
    org_id: RegistryIdSchema,
    package_name: PackNameSchema.nullable(),
    after_package_name: PackNameSchema,
    after_version: SemverSchema,
  })
  .strict();
const RegistryMemberCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("members"),
    org_id: RegistryIdSchema,
    after_user_id: RegistryIdSchema,
  })
  .strict();
const RegistryAuditCursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("audit"),
    org_id: RegistryIdSchema,
    after_sequence: z.number().int().positive(),
  })
  .strict();

export interface RegistryPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export type PublicRegistryPage<T> = RegistryPage<T>;

const CredentialFreeHttpsUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source URL must be credential-free HTTPS",
      });
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      value.includes("?") ||
      value.includes("#")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "source URL must be absolute credential-free HTTPS without query or fragment",
      });
    }
  });

export const RegistryRoleSchema = z.enum([
  "viewer",
  "publisher",
  "admin",
  "owner",
]);
export const RegistryPackageVisibilitySchema = z.enum(["private", "public"]);
export const RegistryReleaseStatusSchema = z.enum([
  "pending",
  "published",
  "rejected",
  "yanked",
]);

export const RegistryUserSchema = z
  .object({
    id: RegistryIdSchema,
    email: z.string().trim().toLowerCase().email().max(320),
    display_name: RegistryDisplayNameSchema,
    created_at: RegistryTimestampSchema,
  })
  .strict();

export const RegistryOrganizationSchema = z
  .object({
    id: RegistryIdSchema,
    slug: RegistrySlugSchema,
    display_name: RegistryDisplayNameSchema,
    created_by: RegistryIdSchema,
    created_at: RegistryTimestampSchema,
  })
  .strict();

export const RegistryMemberSchema = z
  .object({
    org_id: RegistryIdSchema,
    user_id: RegistryIdSchema,
    role: RegistryRoleSchema,
    joined_at: RegistryTimestampSchema,
  })
  .strict();

export const RegistryPackageSchema = z
  .object({
    id: RegistryIdSchema,
    org_id: RegistryIdSchema,
    name: PackNameSchema,
    visibility: RegistryPackageVisibilitySchema,
    created_by: RegistryIdSchema,
    created_at: RegistryTimestampSchema,
  })
  .strict();

export const PublicRegistryPackageSearchHitSchema = RegistryPackageSchema.extend({
  latest_version: SemverSchema.nullable(),
  discovery_available: z.boolean(),
  discovery: PublicPackDiscoveryDocumentSchema,
}).strict();

export const RegistryArtifactSchema = z
  .object({
    integrity: Sha256IntegritySchema,
    provenance: z
      .object({
        source_type: z.literal("git"),
        source_url: CredentialFreeHttpsUrlSchema,
        source_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .strict(),
  })
  .strict();

export const RegistryReleaseApprovalSchema = z
  .object({
    user_id: RegistryIdSchema,
    approved_at: RegistryTimestampSchema,
  })
  .strict();

export const RegistryReleaseSchema = z
  .object({
    id: RegistryIdSchema,
    org_id: RegistryIdSchema,
    package_id: RegistryIdSchema,
    package_name: PackNameSchema,
    version: SemverSchema,
    artifact: RegistryArtifactSchema,
    status: RegistryReleaseStatusSchema,
    approvals: z.array(RegistryReleaseApprovalSchema).max(2),
    submitted_by: RegistryIdSchema,
    submitted_at: RegistryTimestampSchema,
    published_at: RegistryTimestampSchema.nullable(),
    rejected_at: RegistryTimestampSchema.nullable(),
    rejection_reason: RegistryReasonSchema.nullable(),
    yanked_at: RegistryTimestampSchema.nullable(),
    yank_reason: RegistryReasonSchema.nullable(),
  })
  .strict()
  .superRefine((release, context) => {
    const approvers = release.approvals.map((approval) => approval.user_id);
    if (new Set(approvers).size !== approvers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals"],
        message: "release approvals must come from distinct users",
      });
    }
    if (approvers.includes(release.submitted_by)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals"],
        message: "release submitter cannot approve their own release",
      });
    }

    const hasPublishedState =
      release.status === "published" || release.status === "yanked";
    if (hasPublishedState && release.approvals.length !== 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals"],
        message: "published releases require exactly two approvals",
      });
    }
    if (!hasPublishedState && release.published_at !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["published_at"],
        message: "only published or yanked releases may have published_at",
      });
    }
    if (hasPublishedState && release.published_at === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["published_at"],
        message: "published or yanked releases require published_at",
      });
    }

    if (release.status === "rejected") {
      if (release.rejected_at === null || release.rejection_reason === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejected_at"],
          message: "rejected releases require a timestamp and reason",
        });
      }
    } else if (
      release.rejected_at !== null ||
      release.rejection_reason !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejected_at"],
        message: "only rejected releases may have rejection details",
      });
    }

    if (release.status === "yanked") {
      if (release.yanked_at === null || release.yank_reason === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["yanked_at"],
          message: "yanked releases require a timestamp and reason",
        });
      }
    } else if (release.yanked_at !== null || release.yank_reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["yanked_at"],
        message: "only yanked releases may have yank details",
      });
    }

    if (release.status === "pending" && release.approvals.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals"],
        message: "a second approval must publish the release atomically",
      });
    }
  });

export const RegistryAuditActionSchema = z.enum([
  "organization.created",
  "organization.bootstrapped",
  "member.added",
  "member.role_changed",
  "member.removed",
  "package.created",
  "release.submitted",
  "release.approved",
  "release.published",
  "release.rejected",
  "release.yanked",
  "token.issued",
  "token.revoked",
  "token.subject_revoked",
]);

const RegistryAuditMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const RegistryAuditEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    id: RegistryIdSchema,
    request_id: z.string().trim().min(1).max(256),
    org_id: RegistryIdSchema,
    actor_user_id: RegistryIdSchema.nullable(),
    actor_kind: z.enum(["human", "service", "system"]),
    action: RegistryAuditActionSchema,
    subject_type: z.enum([
      "organization",
      "member",
      "package",
      "release",
      "api_token",
    ]),
    subject_id: z.string().trim().min(1).max(256),
    metadata: z.record(RegistryAuditMetadataValueSchema),
    occurred_at: RegistryTimestampSchema,
  })
  .strict();

export const RegisterRegistryUserInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    display_name: RegistryDisplayNameSchema,
  })
  .strict();

export const CreateRegistryOrganizationInputSchema = z
  .object({
    slug: RegistrySlugSchema,
    display_name: RegistryDisplayNameSchema,
  })
  .strict();

export const AddRegistryMemberInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    user_id: RegistryIdSchema,
    role: RegistryRoleSchema,
  })
  .strict();

/**
 * Pre-provision one external identity so its first verified OIDC request can
 * resolve to an existing local user and organization membership.
 */
export const ProvisionExternalRegistryMemberInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    identity_issuer: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === ""
        );
      }, "identity issuer must be a credential-free HTTPS URL"),
    provider_subject: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
        "provider subject must be a bounded opaque identifier",
      ),
    display_name: RegistryDisplayNameSchema,
    role: RegistryRoleSchema,
  })
  .strict();

export const UpdateRegistryMemberInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    user_id: RegistryIdSchema,
    role: RegistryRoleSchema,
  })
  .strict();

export const RemoveRegistryMemberInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    user_id: RegistryIdSchema,
    reason: RegistryReasonSchema,
  })
  .strict();

export const CreateRegistryPackageInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    name: PackNameSchema,
    visibility: RegistryPackageVisibilitySchema,
  })
  .strict();

export const SubmitRegistryReleaseInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    package_name: PackNameSchema,
    version: SemverSchema,
    artifact: RegistryArtifactSchema,
  })
  .strict();

const RegistryReleaseIdentityInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    package_name: PackNameSchema,
    version: SemverSchema,
  })
  .strict();

export const ReviewRegistryReleaseInputSchema =
  RegistryReleaseIdentityInputSchema;

export const RejectRegistryReleaseInputSchema =
  RegistryReleaseIdentityInputSchema.extend({
    reason: RegistryReasonSchema,
  }).strict();

export const YankRegistryReleaseInputSchema =
  RegistryReleaseIdentityInputSchema.extend({
    reason: RegistryReasonSchema,
  }).strict();

export const RegistryOrganizationIdentityInputSchema = z
  .object({ org_id: RegistryIdSchema })
  .strict();

const RegistryPageInputFields = {
  limit: RegistryPageLimitSchema,
  cursor: RegistryCursorTextSchema.optional(),
} as const;

export const ListRegistryTokensPageInputSchema = z
  .object({ org_id: RegistryIdSchema, ...RegistryPageInputFields })
  .strict();

export const ListRegistryMembersPageInputSchema = z
  .object({ org_id: RegistryIdSchema, ...RegistryPageInputFields })
  .strict();

export const ListRegistryPackagesPageInputSchema = z
  .object({ org_id: RegistryIdSchema, ...RegistryPageInputFields })
  .strict();

export const ListRegistryAuditEventsPageInputSchema = z
  .object({ org_id: RegistryIdSchema, ...RegistryPageInputFields })
  .strict();

export const GetRegistryPackageInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    name: PackNameSchema,
  })
  .strict();

export const ListRegistryReleasesInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    package_name: PackNameSchema.optional(),
  })
  .strict();

export const ListRegistryReleasesPageInputSchema = z
  .object({
    org_id: RegistryIdSchema,
    package_name: PackNameSchema.optional(),
    ...RegistryPageInputFields,
  })
  .strict();

const PublicRegistryDiscoveryFilterValuesSchema = z
  .array(z.string().max(256))
  .max(4)
  .default([]);

export const SearchPublicRegistryPackagesInputSchema = z
  .object({
    query: z.string().trim().max(128).default(""),
    languages: PublicRegistryDiscoveryFilterValuesSchema,
    ecosystems: PublicRegistryDiscoveryFilterValuesSchema,
    tags: PublicRegistryDiscoveryFilterValuesSchema,
    limit: RegistryPageLimitSchema,
    cursor: RegistryCursorTextSchema.optional(),
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

export const GetPublicRegistryPackageInputSchema = z
  .object({
    name: PackNameSchema,
  })
  .strict();

export const GetPublicRegistryReleaseInputSchema = z
  .object({
    package_name: PackNameSchema,
    version: SemverSchema,
  })
  .strict();

export const ListPublicRegistryReleasesInputSchema = z
  .object({
    package_name: PackNameSchema,
    limit: RegistryPageLimitSchema,
    cursor: RegistryCursorTextSchema.optional(),
  })
  .strict();

export function decodePublicRegistryPackageCursor(
  cursor: string | undefined,
  query: string,
  filterInput: PublicPackDiscoveryFilterInput = {},
): string | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodePublicRegistryCursor(
    cursor,
    PublicRegistryPackageCursorDocumentSchema,
  );
  const filter = normalizePublicPackDiscoveryFilter(filterInput);
  if (payload.v === 1) {
    if (
      payload.query !== query ||
      filter.languages.length > 0 ||
      filter.ecosystems.length > 0 ||
      filter.tags.length > 0
    ) {
      throwInvalidPublicRegistryCursor(cursor);
    }
  } else if (
    payload.request_hash !== publicRegistryPackageRequestHash(query, filter)
  ) {
    throwInvalidPublicRegistryCursor(cursor);
  }
  return payload.after_name;
}

export function encodePublicRegistryPackageCursor(
  query: string,
  afterName: string,
  filterInput: PublicPackDiscoveryFilterInput = {},
): string {
  return encodePublicRegistryCursor(
    PublicRegistryPackageCursorSchema.parse({
      v: 2,
      kind: "packages",
      request_hash: publicRegistryPackageRequestHash(query, filterInput),
      after_name: afterName,
    }),
  );
}

function publicRegistryPackageRequestHash(
  query: string,
  filterInput: PublicPackDiscoveryFilterInput,
): string {
  const filter = normalizePublicPackDiscoveryFilter(filterInput);
  return createHash("sha256")
    .update(
      JSON.stringify({
        query,
        languages: filter.languages,
        ecosystems: filter.ecosystems,
        tags: filter.tags,
      }),
      "utf8",
    )
    .digest("base64url");
}

export function decodePublicRegistryReleaseCursor(
  cursor: string | undefined,
  packageName: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodePublicRegistryCursor(
    cursor,
    PublicRegistryReleaseCursorSchema,
  );
  if (payload.package_name !== packageName) {
    throwInvalidPublicRegistryCursor(cursor);
  }
  return payload.after_version;
}

export function encodePublicRegistryReleaseCursor(
  packageName: string,
  afterVersion: string,
): string {
  return encodePublicRegistryCursor(
    PublicRegistryReleaseCursorSchema.parse({
      v: 1,
      kind: "releases",
      package_name: packageName,
      after_version: afterVersion,
    }),
  );
}

export interface RegistryTokenCursorPosition {
  readonly createdAt: string;
  readonly tokenId: string;
}

export function decodeRegistryTokenCursor(
  cursor: string | undefined,
  orgId: string,
): RegistryTokenCursorPosition | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodeRegistryCursor(cursor, RegistryTokenCursorSchema);
  if (payload.org_id !== orgId) throwInvalidRegistryCursor(cursor);
  return { createdAt: payload.after_created_at, tokenId: payload.after_id };
}

export function encodeRegistryTokenCursor(
  orgId: string,
  position: RegistryTokenCursorPosition,
): string {
  return encodeRegistryCursor(
    RegistryTokenCursorSchema.parse({
      v: 1,
      kind: "tokens",
      org_id: orgId,
      after_created_at: position.createdAt,
      after_id: position.tokenId,
    }),
  );
}

export function decodeRegistryPackageCursor(
  cursor: string | undefined,
  orgId: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodeRegistryCursor(cursor, RegistryPackageCursorSchema);
  if (payload.org_id !== orgId) throwInvalidRegistryCursor(cursor);
  return payload.after_name;
}

export function encodeRegistryPackageCursor(
  orgId: string,
  afterName: string,
): string {
  return encodeRegistryCursor(
    RegistryPackageCursorSchema.parse({
      v: 1,
      kind: "org_packages",
      org_id: orgId,
      after_name: afterName,
    }),
  );
}

export interface RegistryReleaseCursorPosition {
  readonly packageName: string;
  readonly version: string;
}

export function decodeRegistryReleaseCursor(
  cursor: string | undefined,
  orgId: string,
  packageName: string | undefined,
): RegistryReleaseCursorPosition | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodeRegistryCursor(cursor, RegistryReleaseCursorSchema);
  if (
    payload.org_id !== orgId ||
    payload.package_name !== (packageName ?? null)
  ) {
    throwInvalidRegistryCursor(cursor);
  }
  return {
    packageName: payload.after_package_name,
    version: payload.after_version,
  };
}

export function encodeRegistryReleaseCursor(
  orgId: string,
  packageName: string | undefined,
  position: RegistryReleaseCursorPosition,
): string {
  return encodeRegistryCursor(
    RegistryReleaseCursorSchema.parse({
      v: 1,
      kind: "org_releases",
      org_id: orgId,
      package_name: packageName ?? null,
      after_package_name: position.packageName,
      after_version: position.version,
    }),
  );
}

export function decodeRegistryMemberCursor(
  cursor: string | undefined,
  orgId: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodeRegistryCursor(cursor, RegistryMemberCursorSchema);
  if (payload.org_id !== orgId) throwInvalidRegistryCursor(cursor);
  return payload.after_user_id;
}

export function encodeRegistryMemberCursor(
  orgId: string,
  afterUserId: string,
): string {
  return encodeRegistryCursor(
    RegistryMemberCursorSchema.parse({
      v: 1,
      kind: "members",
      org_id: orgId,
      after_user_id: afterUserId,
    }),
  );
}

export function decodeRegistryAuditCursor(
  cursor: string | undefined,
  orgId: string,
): number | undefined {
  if (cursor === undefined) return undefined;
  const payload = decodeRegistryCursor(cursor, RegistryAuditCursorSchema);
  if (payload.org_id !== orgId) throwInvalidRegistryCursor(cursor);
  return payload.after_sequence;
}

export function encodeRegistryAuditCursor(
  orgId: string,
  afterSequence: number,
): string {
  return encodeRegistryCursor(
    RegistryAuditCursorSchema.parse({
      v: 1,
      kind: "audit",
      org_id: orgId,
      after_sequence: afterSequence,
    }),
  );
}

function decodePublicRegistryCursor<Schema extends z.ZodTypeAny>(
  cursor: string,
  schema: Schema,
): z.output<Schema> {
  return decodeRegistryCursor(cursor, schema);
}

function decodeRegistryCursor<Schema extends z.ZodTypeAny>(
  cursor: string,
  schema: Schema,
): z.output<Schema> {
  const canonical = RegistryCursorTextSchema.parse(cursor);
  let decoded: unknown;
  try {
    const bytes = Buffer.from(canonical, "base64url");
    if (bytes.toString("base64url") !== canonical) {
      throw new Error("Non-canonical base64url cursor");
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throwInvalidRegistryCursor(cursor);
  }
  return schema.parse(decoded);
}

function encodePublicRegistryCursor(payload: object): string {
  return encodeRegistryCursor(payload);
}

function encodeRegistryCursor(payload: object): string {
  const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return RegistryCursorTextSchema.parse(cursor);
}

function throwInvalidPublicRegistryCursor(cursor: string): never {
  return throwInvalidRegistryCursor(cursor);
}

function throwInvalidRegistryCursor(cursor: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ["cursor"],
      message: "Registry cursor is invalid or does not match the request",
      params: { cursor_length: cursor.length },
    },
  ]);
}

export type RegistryUser = z.infer<typeof RegistryUserSchema>;
export type RegistryOrganization = z.infer<
  typeof RegistryOrganizationSchema
>;
export type RegistryMember = z.infer<typeof RegistryMemberSchema>;
export type RegistryPackage = z.infer<typeof RegistryPackageSchema>;
export type PublicRegistryPackageSearchHit = z.infer<
  typeof PublicRegistryPackageSearchHitSchema
>;
export type RegistryArtifact = z.infer<typeof RegistryArtifactSchema>;
export type RegistryRelease = z.infer<typeof RegistryReleaseSchema>;
export type RegistryAuditEvent = z.infer<typeof RegistryAuditEventSchema>;
export type RegistryRole = z.infer<typeof RegistryRoleSchema>;

export class RegistryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConflictError";
  }
}

export class RegistryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryNotFoundError";
  }
}

export class RegistryForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryForbiddenError";
  }
}

export class RegistryTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryTransitionError";
  }
}

export class RegistrySeatLimitError extends Error {
  constructor() {
    super("Registry organization seat limit exceeded");
    this.name = "RegistrySeatLimitError";
  }
}

type AuditDraft = Omit<RegistryAuditEvent, "sequence">;

/**
 * Synchronous in-memory adapter for the Registry domain.
 *
 * The release uniqueness check and Map insertion happen in one synchronous
 * method with no await boundary. That gives callers atomic same-process
 * name@version reservation semantics; a persistent adapter must provide the
 * equivalent unique constraint/transaction.
 */
export class InMemoryRegistryRepository {
  readonly #users = new Map<string, RegistryUser>();
  readonly #userIdsByEmail = new Map<string, string>();
  readonly #organizations = new Map<string, RegistryOrganization>();
  readonly #organizationIdsBySlug = new Map<string, string>();
  readonly #members = new Map<string, RegistryMember>();
  readonly #packages = new Map<string, RegistryPackage>();
  readonly #releases = new Map<string, RegistryRelease>();
  readonly #releaseDiscovery = new Map<
    string,
    PublicPackDiscoveryDocument
  >();
  readonly #auditEvents: RegistryAuditEvent[] = [];
  #nextAuditSequence = 1;

  insertUser(user: RegistryUser): RegistryUser {
    const parsed = RegistryUserSchema.parse(user);
    if (this.#users.has(parsed.id)) {
      throw new RegistryConflictError(`User id already exists: ${parsed.id}`);
    }
    if (this.#userIdsByEmail.has(parsed.email)) {
      throw new RegistryConflictError(
        `User email already exists: ${parsed.email}`,
      );
    }
    this.#users.set(parsed.id, parsed);
    this.#userIdsByEmail.set(parsed.email, parsed.id);
    return RegistryUserSchema.parse(parsed);
  }

  getUser(userId: string): RegistryUser | undefined {
    const user = this.#users.get(RegistryIdSchema.parse(userId));
    return user ? RegistryUserSchema.parse(user) : undefined;
  }

  insertOrganization(
    organization: RegistryOrganization,
  ): RegistryOrganization {
    const parsed = RegistryOrganizationSchema.parse(organization);
    if (this.#organizations.has(parsed.id)) {
      throw new RegistryConflictError(
        `Organization id already exists: ${parsed.id}`,
      );
    }
    if (this.#organizationIdsBySlug.has(parsed.slug)) {
      throw new RegistryConflictError(
        `Organization slug already exists: ${parsed.slug}`,
      );
    }
    this.#organizations.set(parsed.id, parsed);
    this.#organizationIdsBySlug.set(parsed.slug, parsed.id);
    return RegistryOrganizationSchema.parse(parsed);
  }

  getOrganization(orgId: string): RegistryOrganization | undefined {
    const organization = this.#organizations.get(RegistryIdSchema.parse(orgId));
    return organization
      ? RegistryOrganizationSchema.parse(organization)
      : undefined;
  }

  insertMember(member: RegistryMember): RegistryMember {
    const parsed = RegistryMemberSchema.parse(member);
    const key = membershipKey(parsed.org_id, parsed.user_id);
    if (this.#members.has(key)) {
      throw new RegistryConflictError(
        `Organization member already exists: ${parsed.user_id}`,
      );
    }
    this.#members.set(key, parsed);
    return RegistryMemberSchema.parse(parsed);
  }

  replaceMemberRole(
    orgId: string,
    userId: string,
    role: RegistryRole,
  ): RegistryMember {
    const key = membershipKey(
      RegistryIdSchema.parse(orgId),
      RegistryIdSchema.parse(userId),
    );
    const current = this.#members.get(key);
    if (!current) {
      throw new RegistryNotFoundError(`Organization member not found: ${userId}`);
    }
    const next = RegistryMemberSchema.parse({ ...current, role });
    this.#members.set(key, next);
    return RegistryMemberSchema.parse(next);
  }

  removeMember(orgId: string, userId: string): RegistryMember {
    const key = membershipKey(
      RegistryIdSchema.parse(orgId),
      RegistryIdSchema.parse(userId),
    );
    const current = this.#members.get(key);
    if (!current) {
      throw new RegistryNotFoundError(`Organization member not found: ${userId}`);
    }
    this.#members.delete(key);
    return RegistryMemberSchema.parse(current);
  }

  getMember(orgId: string, userId: string): RegistryMember | undefined {
    const member = this.#members.get(
      membershipKey(
        RegistryIdSchema.parse(orgId),
        RegistryIdSchema.parse(userId),
      ),
    );
    return member ? RegistryMemberSchema.parse(member) : undefined;
  }

  listMembers(orgId: string): RegistryMember[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    return [...this.#members.values()]
      .filter((member) => member.org_id === validOrgId)
      .map((member) => RegistryMemberSchema.parse(member));
  }

  listMemberPage(
    orgId: string,
    afterUserId: string | undefined,
    limit: number,
  ): RegistryMember[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const validAfterUserId = afterUserId
      ? RegistryIdSchema.parse(afterUserId)
      : undefined;
    return [...this.#members.values()]
      .filter(
        (member) =>
          member.org_id === validOrgId &&
          (validAfterUserId === undefined || member.user_id > validAfterUserId),
      )
      .sort((left, right) => compareAscendingText(left.user_id, right.user_id))
      .slice(0, pageReadLimit(limit))
      .map((member) => RegistryMemberSchema.parse(member));
  }

  insertPackage(registryPackage: RegistryPackage): RegistryPackage {
    const parsed = RegistryPackageSchema.parse(registryPackage);
    if (this.#packages.has(parsed.name)) {
      throw new RegistryConflictError(
        `Registry package name already exists: ${parsed.name}`,
      );
    }
    this.#packages.set(parsed.name, parsed);
    return RegistryPackageSchema.parse(parsed);
  }

  getPackage(orgId: string, name: string): RegistryPackage | undefined {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const registryPackage = this.#packages.get(PackNameSchema.parse(name));
    if (!registryPackage || registryPackage.org_id !== validOrgId) return undefined;
    return RegistryPackageSchema.parse(registryPackage);
  }

  listPackages(orgId: string): RegistryPackage[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    return [...this.#packages.values()]
      .filter((registryPackage) => registryPackage.org_id === validOrgId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((registryPackage) => RegistryPackageSchema.parse(registryPackage));
  }

  listPackagePage(
    orgId: string,
    afterName: string | undefined,
    limit: number,
  ): RegistryPackage[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const validAfterName = afterName ? PackNameSchema.parse(afterName) : undefined;
    return [...this.#packages.values()]
      .filter(
        (registryPackage) =>
          registryPackage.org_id === validOrgId &&
          (validAfterName === undefined || registryPackage.name > validAfterName),
      )
      .sort((left, right) => compareAscendingText(left.name, right.name))
      .slice(0, pageReadLimit(limit))
      .map((registryPackage) => RegistryPackageSchema.parse(registryPackage));
  }

  listPublicPackages(
    query = "",
    afterName?: string,
    limit?: number,
    filterInput: PublicPackDiscoveryFilterInput = {},
  ): PublicRegistryPackageSearchHit[] {
    const normalizedQuery = query.toLocaleLowerCase("en-US");
    const filter = normalizePublicPackDiscoveryFilter(filterInput);
    const validAfterName = afterName
      ? PackNameSchema.parse(afterName)
      : undefined;
    const matches = [...this.#packages.values()]
      .map((registryPackage) => {
        const projected = this.#latestPublishedDiscovery(registryPackage.name);
        return PublicRegistryPackageSearchHitSchema.parse({
          ...registryPackage,
          latest_version: projected.latestVersion,
          discovery_available: projected.discoveryAvailable,
          discovery: projected.discovery,
        });
      })
      .filter(
        (registryPackage) =>
          registryPackage.visibility === "public" &&
          registryPackage.name.toLocaleLowerCase("en-US").includes(normalizedQuery) &&
          matchesPublicPackDiscoveryFilter(registryPackage.discovery, filter) &&
          (validAfterName === undefined || registryPackage.name > validAfterName),
      )
      .sort((left, right) => compareAscendingText(left.name, right.name));
    return (
      limit === undefined ? matches : matches.slice(0, pageReadLimit(limit))
    ).map((registryPackage) =>
      PublicRegistryPackageSearchHitSchema.parse(registryPackage),
    );
  }

  getPublicPackage(name: string): RegistryPackage | undefined {
    const registryPackage = this.#packages.get(PackNameSchema.parse(name));
    if (!registryPackage || registryPackage.visibility !== "public") return undefined;
    return RegistryPackageSchema.parse(registryPackage);
  }

  insertReleaseIfAbsent(
    release: RegistryRelease,
    discoveryInput?: PublicPackDiscoveryDocument,
  ): RegistryRelease {
    const parsed = RegistryReleaseSchema.parse(release);
    const discovery =
      discoveryInput === undefined
        ? undefined
        : PublicPackDiscoveryDocumentSchema.parse(discoveryInput);
    const key = releaseKey(parsed.package_name, parsed.version);
    if (this.#releases.has(key)) {
      throw new RegistryConflictError(
        `Release is immutable and already exists: ${parsed.package_name}@${parsed.version}`,
      );
    }
    this.#releases.set(key, parsed);
    if (discovery) this.#releaseDiscovery.set(key, discovery);
    return RegistryReleaseSchema.parse(parsed);
  }

  replaceReleaseState(release: RegistryRelease): RegistryRelease {
    const parsed = RegistryReleaseSchema.parse(release);
    const key = releaseKey(parsed.package_name, parsed.version);
    const current = this.#releases.get(key);
    if (!current) {
      throw new RegistryNotFoundError(
        `Release not found: ${parsed.package_name}@${parsed.version}`,
      );
    }
    if (immutableReleaseIdentity(current) !== immutableReleaseIdentity(parsed)) {
      throw new RegistryConflictError(
        `Release artifact identity is immutable: ${parsed.package_name}@${parsed.version}`,
      );
    }
    this.#releases.set(key, parsed);
    return RegistryReleaseSchema.parse(parsed);
  }

  getRelease(
    orgId: string,
    packageName: string,
    version: string,
  ): RegistryRelease | undefined {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const release = this.#releases.get(
      releaseKey(PackNameSchema.parse(packageName), SemverSchema.parse(version)),
    );
    if (!release || release.org_id !== validOrgId) return undefined;
    return RegistryReleaseSchema.parse(release);
  }

  listReleases(orgId: string, packageName?: string): RegistryRelease[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const validPackageName = packageName
      ? PackNameSchema.parse(packageName)
      : undefined;
    return [...this.#releases.values()]
      .filter(
        (release) =>
          release.org_id === validOrgId &&
          (validPackageName === undefined ||
            release.package_name === validPackageName),
      )
      .sort((left, right) =>
        `${left.package_name}@${left.version}`.localeCompare(
          `${right.package_name}@${right.version}`,
        ),
      )
      .map((release) => RegistryReleaseSchema.parse(release));
  }

  listReleasePage(
    orgId: string,
    packageName: string | undefined,
    after: RegistryReleaseCursorPosition | undefined,
    limit: number,
  ): RegistryRelease[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const validPackageName = packageName
      ? PackNameSchema.parse(packageName)
      : undefined;
    const matches = [...this.#releases.values()].filter(
      (release) =>
        release.org_id === validOrgId &&
        (validPackageName === undefined ||
          release.package_name === validPackageName),
    );
    return matches
      .filter(
        (release) =>
          after === undefined ||
          compareRegistryReleaseIdentities(release, after) > 0,
      )
      .sort(compareRegistryReleaseIdentities)
      .slice(0, pageReadLimit(limit))
      .map((release) => RegistryReleaseSchema.parse(release));
  }

  getPublicRelease(
    packageName: string,
    version: string,
  ): RegistryRelease | undefined {
    const registryPackage = this.getPublicPackage(packageName);
    if (!registryPackage) return undefined;
    const release = this.#releases.get(
      releaseKey(registryPackage.name, SemverSchema.parse(version)),
    );
    if (
      !release ||
      (release.status !== "published" && release.status !== "yanked")
    ) {
      return undefined;
    }
    return RegistryReleaseSchema.parse(release);
  }

  listPublicReleases(
    packageName: string,
    afterVersion?: string,
    limit?: number,
  ): RegistryRelease[] {
    const registryPackage = this.getPublicPackage(packageName);
    if (!registryPackage) return [];
    const validAfterVersion = afterVersion
      ? SemverSchema.parse(afterVersion)
      : undefined;
    const matches = [...this.#releases.values()]
      .filter(
        (release) =>
          release.package_name === registryPackage.name &&
          (release.status === "published" || release.status === "yanked") &&
          (validAfterVersion === undefined ||
            comparePublicReleaseVersions(release.version, validAfterVersion) > 0),
      )
      .sort((left, right) =>
        comparePublicReleaseVersions(left.version, right.version),
      );
    return (
      limit === undefined ? matches : matches.slice(0, pageReadLimit(limit))
    ).map((release) => RegistryReleaseSchema.parse(release));
  }

  #latestPublishedDiscovery(packageName: string): {
    latestVersion: string | null;
    discoveryAvailable: boolean;
    discovery: PublicPackDiscoveryDocument;
  } {
    const latest = [...this.#releases.values()]
      .filter(
        (release) =>
          release.package_name === packageName && release.status === "published",
      )
      .sort((left, right) =>
        comparePublicReleaseVersions(left.version, right.version),
      )[0];
    if (!latest) {
      return {
        latestVersion: null,
        discoveryAvailable: false,
        discovery: emptyPublicPackDiscoveryDocument(),
      };
    }
    const discovery = this.#releaseDiscovery.get(
      releaseKey(latest.package_name, latest.version),
    );
    return {
      latestVersion: latest.version,
      discoveryAvailable: discovery !== undefined,
      discovery: PublicPackDiscoveryDocumentSchema.parse(
        discovery ?? emptyPublicPackDiscoveryDocument(),
      ),
    };
  }

  appendAuditEvent(event: AuditDraft): RegistryAuditEvent {
    const parsed = RegistryAuditEventSchema.parse({
      ...event,
      sequence: this.#nextAuditSequence,
    });
    this.#nextAuditSequence += 1;
    this.#auditEvents.push(parsed);
    return RegistryAuditEventSchema.parse(parsed);
  }

  listAuditEvents(orgId: string): RegistryAuditEvent[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    return this.#auditEvents
      .filter((event) => event.org_id === validOrgId)
      .map((event) => RegistryAuditEventSchema.parse(event));
  }

  listAuditEventPage(
    orgId: string,
    afterSequence: number | undefined,
    limit: number,
  ): RegistryAuditEvent[] {
    const validOrgId = RegistryIdSchema.parse(orgId);
    const validAfterSequence = afterSequence === undefined
      ? undefined
      : z.number().int().positive().parse(afterSequence);
    return this.#auditEvents
      .filter(
        (event) =>
          event.org_id === validOrgId &&
          (validAfterSequence === undefined ||
            event.sequence < validAfterSequence),
      )
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, pageReadLimit(limit))
      .map((event) => RegistryAuditEventSchema.parse(event));
  }
}

export interface RegistryDomainServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
}

export class RegistryDomainService {
  readonly #repository: InMemoryRegistryRepository;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  constructor(
    repository = new InMemoryRegistryRepository(),
    options: RegistryDomainServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  registerUser(input: z.input<typeof RegisterRegistryUserInputSchema>): RegistryUser {
    const parsed = RegisterRegistryUserInputSchema.parse(input);
    return this.#repository.insertUser({
      id: this.#nextId(),
      email: parsed.email,
      display_name: parsed.display_name,
      created_at: this.#now(),
    });
  }

  createOrganization(
    actorUserId: string,
    input: z.input<typeof CreateRegistryOrganizationInputSchema>,
  ): RegistryOrganization {
    const actor = this.#requireUser(actorUserId);
    const parsed = CreateRegistryOrganizationInputSchema.parse(input);
    const now = this.#now();
    const organization = this.#repository.insertOrganization({
      id: this.#nextId(),
      slug: parsed.slug,
      display_name: parsed.display_name,
      created_by: actor.id,
      created_at: now,
    });
    this.#repository.insertMember({
      org_id: organization.id,
      user_id: actor.id,
      role: "owner",
      joined_at: now,
    });
    this.#audit(
      organization.id,
      actor.id,
      "organization.created",
      "organization",
      organization.id,
      { slug: organization.slug },
    );
    return organization;
  }

  addMember(
    actorUserId: string,
    input: z.input<typeof AddRegistryMemberInputSchema>,
  ): RegistryMember {
    const parsed = AddRegistryMemberInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    if (parsed.role === "owner" && actor.role !== "owner") {
      throw new RegistryForbiddenError("Only an owner may grant the owner role");
    }
    this.#requireUser(parsed.user_id);
    const member = this.#repository.insertMember({
      org_id: parsed.org_id,
      user_id: parsed.user_id,
      role: parsed.role,
      joined_at: this.#now(),
    });
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "member.added",
      "member",
      parsed.user_id,
      { role: parsed.role },
    );
    return member;
  }

  updateMemberRole(
    actorUserId: string,
    input: z.input<typeof UpdateRegistryMemberInputSchema>,
  ): RegistryMember {
    const parsed = UpdateRegistryMemberInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    const current = this.#repository.getMember(parsed.org_id, parsed.user_id);
    if (!current) throw new RegistryNotFoundError("Registry member not found");
    if (
      (current.role === "owner" || parsed.role === "owner") &&
      actor.role !== "owner"
    ) {
      throw new RegistryForbiddenError("Only an owner may manage owner roles");
    }
    if (current.role === parsed.role) {
      throw new RegistryConflictError("Registry member already has this role");
    }
    if (
      current.role === "owner" &&
      parsed.role !== "owner" &&
      this.#repository
        .listMembers(parsed.org_id)
        .filter((member) => member.role === "owner").length === 1
    ) {
      throw new RegistryConflictError("Organization must retain at least one owner");
    }
    const member = this.#repository.replaceMemberRole(
      parsed.org_id,
      parsed.user_id,
      parsed.role,
    );
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "member.role_changed",
      "member",
      parsed.user_id,
      { previous_role: current.role, role: member.role },
    );
    return member;
  }

  removeMember(
    actorUserId: string,
    input: z.input<typeof RemoveRegistryMemberInputSchema>,
  ): RegistryMember {
    const parsed = RemoveRegistryMemberInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    const current = this.#repository.getMember(parsed.org_id, parsed.user_id);
    if (!current) throw new RegistryNotFoundError("Registry member not found");
    if (current.role === "owner" && actor.role !== "owner") {
      throw new RegistryForbiddenError("Only an owner may remove an owner");
    }
    if (
      current.role === "owner" &&
      this.#repository
        .listMembers(parsed.org_id)
        .filter((member) => member.role === "owner").length === 1
    ) {
      throw new RegistryConflictError("Organization must retain at least one owner");
    }
    const removed = this.#repository.removeMember(parsed.org_id, parsed.user_id);
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "member.removed",
      "member",
      parsed.user_id,
      { previous_role: removed.role, reason: parsed.reason },
    );
    return removed;
  }

  createPackage(
    actorUserId: string,
    input: z.input<typeof CreateRegistryPackageInputSchema>,
  ): RegistryPackage {
    const parsed = CreateRegistryPackageInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
      "publisher",
    ]);
    const organization = this.#requireOrganization(parsed.org_id);
    if (!parsed.name.startsWith(`${organization.slug}/`)) {
      throw new RegistryConflictError(
        `Registry package name must use organization namespace ${organization.slug}/`,
      );
    }
    const registryPackage = this.#repository.insertPackage({
      id: this.#nextId(),
      org_id: parsed.org_id,
      name: parsed.name,
      visibility: parsed.visibility,
      created_by: actor.user_id,
      created_at: this.#now(),
    });
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "package.created",
      "package",
      registryPackage.id,
      { name: registryPackage.name, visibility: registryPackage.visibility },
    );
    return registryPackage;
  }

  submitRelease(
    actorUserId: string,
    input: z.input<typeof SubmitRegistryReleaseInputSchema>,
    discoveryInput?: PublicPackDiscoveryDocument,
  ): RegistryRelease {
    const parsed = SubmitRegistryReleaseInputSchema.parse(input);
    const discovery =
      discoveryInput === undefined
        ? undefined
        : PublicPackDiscoveryDocumentSchema.parse(discoveryInput);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
      "publisher",
    ]);
    const registryPackage = this.#requirePackage(
      parsed.org_id,
      parsed.package_name,
    );
    const release = this.#repository.insertReleaseIfAbsent(
      {
        id: this.#nextId(),
        org_id: parsed.org_id,
        package_id: registryPackage.id,
        package_name: registryPackage.name,
        version: parsed.version,
        artifact: parsed.artifact,
        status: "pending",
        approvals: [],
        submitted_by: actor.user_id,
        submitted_at: this.#now(),
        published_at: null,
        rejected_at: null,
        rejection_reason: null,
        yanked_at: null,
        yank_reason: null,
      },
      discovery,
    );
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "release.submitted",
      "release",
      release.id,
      { package_name: release.package_name, version: release.version },
    );
    return release;
  }

  approveRelease(
    actorUserId: string,
    input: z.input<typeof ReviewRegistryReleaseInputSchema>,
  ): RegistryRelease {
    const parsed = ReviewRegistryReleaseInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    const current = this.#requireRelease(
      parsed.org_id,
      parsed.package_name,
      parsed.version,
    );
    if (current.status !== "pending") {
      throw new RegistryTransitionError(
        `Only pending releases can be approved: ${current.package_name}@${current.version}`,
      );
    }
    if (current.submitted_by === actor.user_id) {
      throw new RegistryForbiddenError(
        "Release submitter cannot approve their own release",
      );
    }
    if (
      current.approvals.some((approval) => approval.user_id === actor.user_id)
    ) {
      throw new RegistryConflictError(
        `User already approved release: ${actor.user_id}`,
      );
    }
    const now = this.#now();
    const approvals = [
      ...current.approvals,
      { user_id: actor.user_id, approved_at: now },
    ];
    const published = approvals.length === 2;
    const next = this.#repository.replaceReleaseState({
      ...current,
      approvals,
      status: published ? "published" : "pending",
      published_at: published ? now : null,
    });
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "release.approved",
      "release",
      current.id,
      {
        package_name: current.package_name,
        version: current.version,
        approval_count: approvals.length,
      },
    );
    if (published) {
      this.#audit(
        parsed.org_id,
        actor.user_id,
        "release.published",
        "release",
        current.id,
        { package_name: current.package_name, version: current.version },
      );
    }
    return next;
  }

  rejectRelease(
    actorUserId: string,
    input: z.input<typeof RejectRegistryReleaseInputSchema>,
  ): RegistryRelease {
    const parsed = RejectRegistryReleaseInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    const current = this.#requireRelease(
      parsed.org_id,
      parsed.package_name,
      parsed.version,
    );
    if (current.status !== "pending") {
      throw new RegistryTransitionError(
        `Only pending releases can be rejected: ${current.package_name}@${current.version}`,
      );
    }
    if (current.submitted_by === actor.user_id) {
      throw new RegistryForbiddenError(
        "Release submitter cannot reject their own release",
      );
    }
    const next = this.#repository.replaceReleaseState({
      ...current,
      status: "rejected",
      rejected_at: this.#now(),
      rejection_reason: parsed.reason,
    });
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "release.rejected",
      "release",
      current.id,
      {
        package_name: current.package_name,
        version: current.version,
        reason: parsed.reason,
      },
    );
    return next;
  }

  yankRelease(
    actorUserId: string,
    input: z.input<typeof YankRegistryReleaseInputSchema>,
  ): RegistryRelease {
    const parsed = YankRegistryReleaseInputSchema.parse(input);
    const actor = this.#requireRole(actorUserId, parsed.org_id, [
      "owner",
      "admin",
    ]);
    const current = this.#requireRelease(
      parsed.org_id,
      parsed.package_name,
      parsed.version,
    );
    if (current.status !== "published") {
      throw new RegistryTransitionError(
        `Only published releases can be yanked: ${current.package_name}@${current.version}`,
      );
    }
    const next = this.#repository.replaceReleaseState({
      ...current,
      status: "yanked",
      yanked_at: this.#now(),
      yank_reason: parsed.reason,
    });
    this.#audit(
      parsed.org_id,
      actor.user_id,
      "release.yanked",
      "release",
      current.id,
      {
        package_name: current.package_name,
        version: current.version,
        reason: parsed.reason,
      },
    );
    return next;
  }

  getPackage(
    actorUserId: string,
    input: z.input<typeof GetRegistryPackageInputSchema>,
  ): RegistryPackage {
    const parsed = GetRegistryPackageInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    return this.#requirePackage(parsed.org_id, parsed.name);
  }

  getRelease(
    actorUserId: string,
    input: z.input<typeof ReviewRegistryReleaseInputSchema>,
  ): RegistryRelease {
    const parsed = ReviewRegistryReleaseInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    return this.#requireRelease(
      parsed.org_id,
      parsed.package_name,
      parsed.version,
    );
  }

  listMembers(
    actorUserId: string,
    input: z.input<typeof RegistryOrganizationIdentityInputSchema>,
  ): RegistryMember[] {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    this.#requireRole(actorUserId, parsed.org_id, ["owner", "admin"]);
    return this.#repository.listMembers(parsed.org_id);
  }

  listMemberPage(
    actorUserId: string,
    input: z.input<typeof ListRegistryMembersPageInputSchema>,
  ): RegistryPage<RegistryMember> {
    const parsed = ListRegistryMembersPageInputSchema.parse(input);
    this.#requireRole(actorUserId, parsed.org_id, ["owner", "admin"]);
    const afterUserId = decodeRegistryMemberCursor(
      parsed.cursor,
      parsed.org_id,
    );
    const matches = this.#repository.listMemberPage(
      parsed.org_id,
      afterUserId,
      parsed.limit + 1,
    );
    const items = matches.slice(0, parsed.limit);
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
  }

  listPackages(
    actorUserId: string,
    input: z.input<typeof RegistryOrganizationIdentityInputSchema>,
  ): RegistryPackage[] {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    return this.#repository.listPackages(parsed.org_id);
  }

  listPackagePage(
    actorUserId: string,
    input: z.input<typeof ListRegistryPackagesPageInputSchema>,
  ): RegistryPage<RegistryPackage> {
    const parsed = ListRegistryPackagesPageInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    const afterName = decodeRegistryPackageCursor(parsed.cursor, parsed.org_id);
    const matches = this.#repository.listPackagePage(
      parsed.org_id,
      afterName,
      parsed.limit + 1,
    );
    const items = matches.slice(0, parsed.limit);
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
  }

  listReleases(
    actorUserId: string,
    input: z.input<typeof ListRegistryReleasesInputSchema>,
  ): RegistryRelease[] {
    const parsed = ListRegistryReleasesInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    return this.#repository.listReleases(parsed.org_id, parsed.package_name);
  }

  listReleasePage(
    actorUserId: string,
    input: z.input<typeof ListRegistryReleasesPageInputSchema>,
  ): RegistryPage<RegistryRelease> {
    const parsed = ListRegistryReleasesPageInputSchema.parse(input);
    this.#requireMember(actorUserId, parsed.org_id);
    const after = decodeRegistryReleaseCursor(
      parsed.cursor,
      parsed.org_id,
      parsed.package_name,
    );
    const matches = this.#repository.listReleasePage(
      parsed.org_id,
      parsed.package_name,
      after,
      parsed.limit + 1,
    );
    const items = matches.slice(0, parsed.limit);
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
  }

  searchPublicPackages(
    input: z.input<typeof SearchPublicRegistryPackagesInputSchema> = {},
  ): PublicRegistryPage<PublicRegistryPackageSearchHit> {
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
    const matches = this.#repository.listPublicPackages(
      parsed.query,
      afterName,
      parsed.limit + 1,
      filters,
    );
    const items = matches.slice(0, parsed.limit);
    return {
      items,
      next_cursor:
        matches.length > parsed.limit
          ? encodePublicRegistryPackageCursor(
              parsed.query,
              items[items.length - 1]!.name,
              filters,
            )
          : null,
    };
  }

  getPublicPackage(
    input: z.input<typeof GetPublicRegistryPackageInputSchema>,
  ): RegistryPackage {
    const parsed = GetPublicRegistryPackageInputSchema.parse(input);
    const registryPackage = this.#repository.getPublicPackage(parsed.name);
    if (!registryPackage) {
      throw new RegistryNotFoundError("Public Registry package not found");
    }
    return registryPackage;
  }

  getPublicRelease(
    input: z.input<typeof GetPublicRegistryReleaseInputSchema>,
  ): RegistryRelease {
    const parsed = GetPublicRegistryReleaseInputSchema.parse(input);
    const release = this.#repository.getPublicRelease(
      parsed.package_name,
      parsed.version,
    );
    if (!release) {
      throw new RegistryNotFoundError("Public Registry release not found");
    }
    return release;
  }

  listPublicReleases(
    input: z.input<typeof ListPublicRegistryReleasesInputSchema>,
  ): PublicRegistryPage<RegistryRelease> {
    const parsed = ListPublicRegistryReleasesInputSchema.parse(input);
    if (!this.#repository.getPublicPackage(parsed.package_name)) {
      throw new RegistryNotFoundError("Public Registry package not found");
    }
    const afterVersion = decodePublicRegistryReleaseCursor(
      parsed.cursor,
      parsed.package_name,
    );
    const matches = this.#repository.listPublicReleases(
      parsed.package_name,
      afterVersion,
      parsed.limit + 1,
    );
    const items = matches.slice(0, parsed.limit);
    return {
      items,
      next_cursor:
        matches.length > parsed.limit
          ? encodePublicRegistryReleaseCursor(
              parsed.package_name,
              items[items.length - 1]!.version,
            )
          : null,
    };
  }

  listAuditEvents(
    actorUserId: string,
    input: z.input<typeof RegistryOrganizationIdentityInputSchema>,
  ): RegistryAuditEvent[] {
    const parsed = RegistryOrganizationIdentityInputSchema.parse(input);
    this.#requireRole(actorUserId, parsed.org_id, ["owner", "admin"]);
    return this.#repository.listAuditEvents(parsed.org_id);
  }

  listAuditEventPage(
    actorUserId: string,
    input: z.input<typeof ListRegistryAuditEventsPageInputSchema>,
  ): RegistryPage<RegistryAuditEvent> {
    const parsed = ListRegistryAuditEventsPageInputSchema.parse(input);
    this.#requireRole(actorUserId, parsed.org_id, ["owner", "admin"]);
    const afterSequence = decodeRegistryAuditCursor(
      parsed.cursor,
      parsed.org_id,
    );
    const matches = this.#repository.listAuditEventPage(
      parsed.org_id,
      afterSequence,
      parsed.limit + 1,
    );
    const items = matches.slice(0, parsed.limit);
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
  }

  #requireUser(userId: string): RegistryUser {
    const validUserId = RegistryIdSchema.parse(userId);
    const user = this.#repository.getUser(validUserId);
    if (!user) throw new RegistryNotFoundError(`User not found: ${validUserId}`);
    return user;
  }

  #requireOrganization(orgId: string): RegistryOrganization {
    const organization = this.#repository.getOrganization(orgId);
    if (!organization) {
      throw new RegistryNotFoundError(`Organization not found: ${orgId}`);
    }
    return organization;
  }

  #requireMember(userId: string, orgId: string): RegistryMember {
    this.#requireOrganization(orgId);
    this.#requireUser(userId);
    const member = this.#repository.getMember(orgId, userId);
    if (!member) {
      throw new RegistryForbiddenError(
        `User is not a member of organization: ${orgId}`,
      );
    }
    return member;
  }

  #requireRole(
    userId: string,
    orgId: string,
    roles: RegistryRole[],
  ): RegistryMember {
    const member = this.#requireMember(userId, orgId);
    if (!roles.includes(member.role)) {
      throw new RegistryForbiddenError(
        `Role ${member.role} cannot perform this organization action`,
      );
    }
    return member;
  }

  #requirePackage(orgId: string, name: string): RegistryPackage {
    const registryPackage = this.#repository.getPackage(orgId, name);
    if (!registryPackage) {
      throw new RegistryNotFoundError(`Registry package not found: ${name}`);
    }
    return registryPackage;
  }

  #requireRelease(
    orgId: string,
    packageName: string,
    version: string,
  ): RegistryRelease {
    const release = this.#repository.getRelease(orgId, packageName, version);
    if (!release) {
      throw new RegistryNotFoundError(
        `Registry release not found: ${packageName}@${version}`,
      );
    }
    return release;
  }

  #audit(
    orgId: string,
    actorUserId: string,
    action: z.infer<typeof RegistryAuditActionSchema>,
    subjectType: RegistryAuditEvent["subject_type"],
    subjectId: string,
    metadata: RegistryAuditEvent["metadata"],
  ): RegistryAuditEvent {
    const id = this.#nextId();
    return this.#repository.appendAuditEvent({
      id,
      request_id: `local:${id}`,
      org_id: orgId,
      actor_user_id: actorUserId,
      actor_kind: "human",
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      metadata,
      occurred_at: this.#now(),
    });
  }

  #nextId(): string {
    return RegistryIdSchema.parse(this.#idFactory());
  }

  #now(): string {
    const value = this.#clock();
    if (Number.isNaN(value.getTime())) {
      throw new Error("Registry clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

function pageReadLimit(value: number): number {
  return z
    .number()
    .int()
    .min(1)
    .max(MAX_PUBLIC_REGISTRY_PAGE_SIZE + 1)
    .parse(value);
}

function compareAscendingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function comparePublicReleaseVersions(
  left: string,
  right: string,
): number {
  const precedence = compareSemverPrecedence(left, right);
  if (precedence !== 0) return -precedence;
  if (left === right) return 0;
  // Build metadata does not affect SemVer precedence. The raw-version tie-break
  // gives those otherwise-equal immutable releases a deterministic keyset order.
  return left > right ? -1 : 1;
}

function compareSemverPrecedence(left: string, right: string): number {
  const leftVersion = new semver.SemVer(left, { loose: false });
  const rightVersion = new semver.SemVer(right, { loose: false });
  for (const field of ["major", "minor", "patch"] as const) {
    if (leftVersion[field] !== rightVersion[field]) {
      return leftVersion[field] < rightVersion[field] ? -1 : 1;
    }
  }
  if (leftVersion.prerelease.length === 0) {
    return rightVersion.prerelease.length === 0 ? 0 : 1;
  }
  if (rightVersion.prerelease.length === 0) return -1;
  const count = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftText = String(leftIdentifier);
    const rightText = String(rightIdentifier);
    if (leftText === rightText) continue;
    const leftNumeric = /^\d+$/.test(leftText);
    const rightNumeric = /^\d+$/.test(rightText);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftNumeric) {
      if (leftText.length !== rightText.length) {
        return leftText.length < rightText.length ? -1 : 1;
      }
    }
    return leftText < rightText ? -1 : 1;
  }
  return 0;
}

type RegistryReleaseIdentity =
  | { readonly package_name: string; readonly version: string }
  | RegistryReleaseCursorPosition;

export function compareRegistryReleaseIdentities(
  left: RegistryReleaseIdentity,
  right: RegistryReleaseIdentity,
): number {
  const leftPackage = "package_name" in left ? left.package_name : left.packageName;
  const rightPackage = "package_name" in right ? right.package_name : right.packageName;
  const packageOrder = compareAscendingText(leftPackage, rightPackage);
  return packageOrder !== 0
    ? packageOrder
    : comparePublicReleaseVersions(left.version, right.version);
}

function membershipKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function releaseKey(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

function immutableReleaseIdentity(release: RegistryRelease): string {
  return JSON.stringify({
    id: release.id,
    org_id: release.org_id,
    package_id: release.package_id,
    package_name: release.package_name,
    version: release.version,
    artifact: release.artifact,
    submitted_by: release.submitted_by,
    submitted_at: release.submitted_at,
  });
}
