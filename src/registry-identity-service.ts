import {
  createHumanActor,
  type HumanActor,
  type IdentityVerifier,
  type RegistryActor,
  type VerifiedIdentity,
} from "./registry-auth.js";
import { PostgresRegistryRepository } from "./registry-postgres.js";
import type {
  RegistryActorResolutionContext,
  RegistryActorResolver,
} from "./registry-server.js";

/** Maps a verified external OIDC subject to one active local user membership. */
export async function resolvePostgresVerifiedIdentityActor(
  identity: VerifiedIdentity,
  repository: PostgresRegistryRepository,
): Promise<HumanActor | null> {
  const user = await repository.getUserByVerifiedExternalIdentity(
    identity.provider,
    identity.issuer,
    identity.providerSubjectId,
  );
  if (!user || user.status !== "active") return null;
  // Membership rows sit behind row-level security. Always use the verified
  // identity tenant here; callers must never substitute a URL target tenant.
  const membership = await repository.tenantTransaction(
    identity.tenantId,
    (tenant) => tenant.getMember(identity.tenantId, user.id),
  );
  if (!membership) return null;
  return createHumanActor(
    { ...identity, subjectId: user.id },
    membership.role,
  );
}

/** Verifies a bearer assertion, then delegates to the shared exact mapping. */
export function createPostgresOidcActorResolver(
  verifier: IdentityVerifier,
  provider: string,
  repository: PostgresRegistryRepository,
): RegistryActorResolver {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    throw new Error("Registry identity provider id is invalid");
  }
  return async (
    context: RegistryActorResolutionContext,
  ): Promise<RegistryActor | null> => {
    const identity = await verifier.verify({
      provider,
      assertion: context.bearerToken,
      expectedTenantId: context.targetTenantId,
    });
    if (!identity) return null;
    return resolvePostgresVerifiedIdentityActor(identity, repository);
  };
}
