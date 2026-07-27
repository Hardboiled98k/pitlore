import type { RegistryPackArtifact } from "./registry-artifact.js";
import type { PublicPackDiscoveryDocument } from "./registry-search.js";
import type {
  RegistryAuditEvent,
  RegistryDomainService,
  RegistryPage,
  RegistryRelease,
  ProvisionExternalRegistryMemberInputSchema,
  SubmitRegistryReleaseInputSchema,
} from "./registry-domain.js";
import type { z } from "zod";

export type RegistryMaybePromise<T> = T | Promise<T>;

type AsyncMethod<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => RegistryMaybePromise<Awaited<Result>>
  : never;

type RegistryHttpDomainMethod =
  | "addMember"
  | "approveRelease"
  | "createPackage"
  | "getPackage"
  | "getPublicPackage"
  | "getRelease"
  | "listAuditEventPage"
  | "listMemberPage"
  | "listMembers"
  | "listPackagePage"
  | "listPackages"
  | "listReleasePage"
  | "listReleases"
  | "removeMember"
  | "rejectRelease"
  | "searchPublicPackages"
  | "submitRelease"
  | "updateMemberRole"
  | "yankRelease";

/**
 * HTTP-facing Registry domain boundary. The in-memory service is synchronous,
 * while durable adapters may perform database I/O; routes await both through
 * this single contract.
 */
export type RegistryPublicRelease = Omit<RegistryRelease, "approvals"> & {
  readonly approval_count: number;
};

export type RegistryDomainPort = {
  [Key in RegistryHttpDomainMethod]: AsyncMethod<RegistryDomainService[Key]>;
} & {
  /** True when member role/removal mutations revoke tokens atomically. */
  readonly managesMemberTokenRevocation?: boolean;
  getPublicRelease: (
    input: Parameters<RegistryDomainService["getPublicRelease"]>[0],
  ) => RegistryMaybePromise<RegistryRelease | RegistryPublicRelease>;
  listPublicReleases: (
    input: Parameters<RegistryDomainService["listPublicReleases"]>[0],
  ) => RegistryMaybePromise<
    RegistryPage<RegistryRelease | RegistryPublicRelease>
  >;
  listAuditEvents: (
    actorUserId: string,
    input: { org_id: string },
  ) => RegistryMaybePromise<readonly RegistryAuditEvent[]>;
  createPackageWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["createPackage"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["createPackage"]>>>;
  addMemberWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["addMember"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["addMember"]>>>;
  provisionExternalMemberWithContext?: (
    actorUserId: string,
    input: z.input<typeof ProvisionExternalRegistryMemberInputSchema>,
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["addMember"]>>>;
  updateMemberRoleWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["updateMemberRole"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["updateMemberRole"]>>>;
  removeMemberWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["removeMember"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["removeMember"]>>>;
  approveReleaseWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["approveRelease"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["approveRelease"]>>>;
  rejectReleaseWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["rejectRelease"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["rejectRelease"]>>>;
  yankReleaseWithContext?: (
    actorUserId: string,
    input: Parameters<RegistryDomainService["yankRelease"]>[1],
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<Awaited<ReturnType<RegistryDomainService["yankRelease"]>>>;
  /** Durable adapters can reserve release metadata and artifact in one transaction. */
  submitArtifactRelease?: (
    actorUserId: string,
    input: z.input<typeof SubmitRegistryReleaseInputSchema>,
    artifact: RegistryPackArtifact,
    discovery: PublicPackDiscoveryDocument,
    context: RegistryMutationContext,
  ) => RegistryMaybePromise<RegistryRelease>;
  getArtifact?: (
    orgId: string,
    packageName: string,
    version: string,
  ) => RegistryMaybePromise<RegistryPackArtifact | undefined>;
  assertArtifactCompatible?: (
    orgId: string,
    artifact: RegistryPackArtifact,
  ) => RegistryMaybePromise<void>;
};

export interface RegistryMutationContext {
  readonly requestId: string;
  readonly actorKind: "human" | "service";
  /** Null means unlimited; undefined preserves direct domain-call compatibility. */
  readonly maxSeats?: number | null;
}
