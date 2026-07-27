import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  type ApiTokenRecord,
  type RegistryActor,
  type RegistryPermission,
  assertTenantAuthorized,
  authenticateApiToken,
  IdentityProviderUnavailableError,
  RegistryAuthorizationError,
} from "./registry-auth.js";
import {
  AddRegistryMemberInputSchema,
  CreateRegistryPackageInputSchema,
  DEFAULT_PUBLIC_REGISTRY_PAGE_SIZE,
  MAX_PUBLIC_REGISTRY_CURSOR_LENGTH,
  MAX_PUBLIC_REGISTRY_PAGE_SIZE,
  RegistryConflictError,
  RegistryDomainService,
  RegistryForbiddenError,
  RegistryNotFoundError,
  ProvisionExternalRegistryMemberInputSchema,
  RegistrySeatLimitError,
  RegistryTransitionError,
  RejectRegistryReleaseInputSchema,
  RemoveRegistryMemberInputSchema,
  ReviewRegistryReleaseInputSchema,
  SubmitRegistryReleaseInputSchema,
  UpdateRegistryMemberInputSchema,
  YankRegistryReleaseInputSchema,
  type PublicRegistryPackageSearchHit,
  type RegistryPackage,
  type RegistryRelease,
} from "./registry-domain.js";
import { PackNameSchema, SemverSchema } from "./schema.js";
import {
  EntitlementService,
  BillingUnavailableError,
  BillingWebhookRejectedError,
  UnavailableBillingProvider,
  UsageEventSchema,
  UsageLedger,
  UsageConflictError,
  UsageQuotaExceededError,
  SeatLimitExceededError,
  type BillingProvider,
  type BillingWebhookHandlerPort,
  type EntitlementServicePort,
  type UsageLedgerPort,
} from "./registry-telemetry.js";
import {
  InMemoryRegistryArtifactStore,
  RegistryArtifactConflictError,
  RegistryPackArtifactSchema,
  type RegistryArtifactStore,
  type RegistryPackArtifact,
  withMaterializedRegistryPackArtifact,
} from "./registry-artifact.js";
import { diffRegistryPackArtifacts } from "./pack-semantic-diff.js";
import { registerRegistryWeb } from "./registry-web.js";
import { PublicRateLimiter } from "./registry-rate-limit.js";
import {
  BrowserSessionCsrfError,
  registerBrowserAuth,
  type BrowserLoginOptions,
  type BrowserSessionAuthenticator,
} from "./registry-browser-auth.js";
import type {
  RegistryDomainPort,
  RegistryPublicRelease,
} from "./registry-port.js";
import {
  InMemoryRegistryTokenService,
  RegistryTokenNotFoundError,
  type RegistryTokenService,
} from "./registry-token-service.js";
import { isRegistryBearerToken } from "./registry-protocol.js";
import {
  buildPublicPackDiscoveryDocument,
  type PublicPackDiscoveryDocument,
} from "./registry-search.js";

const DEFAULT_BODY_LIMIT = 30 * 1024 * 1024;
const BILLING_WEBHOOK_BODY_LIMIT = 256 * 1024;
const SMALL_JSON_BODY_LIMIT = 64 * 1024;

/** Per-server bridge populated after browser routes share their session store. */
const browserSessionAuthenticators = new WeakMap<
  CreateRegistryServerOptions,
  BrowserSessionAuthenticator
>();
const registryRequestReplies = new WeakMap<FastifyRequest, FastifyReply>();

const OrganizationParamsSchema = z
  .object({ orgId: z.string().uuid() })
  .strict();
const MeQuerySchema = z.object({ org_id: z.string().uuid() }).strict();
const PublicDiscoveryFilterQuerySchema = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string().max(256)).max(4),
);
const PublicSearchQuerySchema = z
  .object({
    query: z.string().trim().max(128).optional(),
    language: PublicDiscoveryFilterQuerySchema.optional(),
    ecosystem: PublicDiscoveryFilterQuerySchema.optional(),
    tag: PublicDiscoveryFilterQuerySchema.optional(),
    include: z.literal("facets").optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_PAGE_SIZE)
      .optional(),
    cursor: z.string().min(1).max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH).optional(),
  })
  .strict();
const PublicPackageQuerySchema = z.object({ name: PackNameSchema }).strict();
const PublicReleaseQuerySchema = z
  .object({ package_name: PackNameSchema, version: SemverSchema })
  .strict();
const PublicReleaseListQuerySchema = z
  .object({
    package_name: PackNameSchema,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PUBLIC_REGISTRY_PAGE_SIZE)
      .optional(),
    cursor: z.string().min(1).max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH).optional(),
  })
  .strict();
const PublicDiffQuerySchema = z
  .object({
    package_name: PackNameSchema,
    from_version: SemverSchema,
    to_version: SemverSchema,
  })
  .strict()
  .refine((query) => query.from_version !== query.to_version, {
    message: "Diff versions must be different",
    path: ["to_version"],
  });
const RegistryPageQueryFields = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PUBLIC_REGISTRY_PAGE_SIZE)
    .optional(),
  cursor: z.string().min(1).max(MAX_PUBLIC_REGISTRY_CURSOR_LENGTH).optional(),
} as const;
const RegistryCollectionPageQuerySchema = z
  .object(RegistryPageQueryFields)
  .strict();
const PackageQuerySchema = z.object({ name: PackNameSchema }).strict();
const ReleaseListQuerySchema = z
  .object({
    package_name: PackNameSchema.optional(),
    ...RegistryPageQueryFields,
  })
  .strict();
const ReleaseQuerySchema = z
  .object({ package_name: PackNameSchema, version: SemverSchema })
  .strict();
const UsageSummaryQuerySchema = z
  .object({ package_name: PackNameSchema.optional() })
  .strict();

const CreatePackageBodySchema = CreateRegistryPackageInputSchema.omit({
  org_id: true,
});
const SubmitReleaseBodySchema = SubmitRegistryReleaseInputSchema.omit({
  org_id: true,
})
  .extend({ pack_artifact: RegistryPackArtifactSchema.optional() })
  .strict()
  .superRefine((body, context) => {
    if (
      body.pack_artifact &&
      (body.pack_artifact.name !== body.package_name ||
        body.pack_artifact.version !== body.version ||
        body.pack_artifact.integrity !== body.artifact.integrity)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pack_artifact"],
        message: "Pack artifact identity must match release metadata",
      });
    }
  });
const ReviewReleaseBodySchema = ReviewRegistryReleaseInputSchema.omit({
  org_id: true,
});
const RejectReleaseBodySchema = RejectRegistryReleaseInputSchema.omit({
  org_id: true,
});
const YankReleaseBodySchema = YankRegistryReleaseInputSchema.omit({
  org_id: true,
});
const AddMemberBodySchema = AddRegistryMemberInputSchema.omit({ org_id: true });
const ProvisionExternalMemberBodySchema =
  ProvisionExternalRegistryMemberInputSchema.omit({
    org_id: true,
    provider: true,
    identity_issuer: true,
  });
const CheckoutBodySchema = z
  .object({ plan: z.enum(["team", "enterprise"]) })
  .strict();
const TokenParamsSchema = OrganizationParamsSchema.extend({
  tokenId: z.string().uuid(),
}).strict();
const MemberParamsSchema = OrganizationParamsSchema.extend({
  userId: z.string().uuid(),
}).strict();
const UpdateMemberBodySchema = UpdateRegistryMemberInputSchema.omit({
  org_id: true,
  user_id: true,
});
const RemoveMemberBodySchema = RemoveRegistryMemberInputSchema.omit({
  org_id: true,
  user_id: true,
});
const IssueTokenBodySchema = z
  .object({
    scopes: z
      .array(z.enum(["pack:read", "pack:publish"]))
      .min(1)
      .max(2)
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        message: "token scopes must be unique",
      }),
    expires_at: z.string().datetime(),
  })
  .strict();

const HttpUsageEventIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const UsageReportBodySchema = z
  .object({
    event_id: HttpUsageEventIdSchema,
    occurred_at: z.string().datetime(),
    kind: z.enum(["install", "retrieve", "check", "false_positive"]),
    consent: z.literal("client-opt-in"),
    package_name: PackNameSchema,
    package_version: SemverSchema,
    lesson_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .nullable()
      .default(null),
    outcome: z
      .enum(["hit", "clean", "used", "irrelevant"])
      .nullable()
      .default(null),
  })
  .strict();

type MaybePromise<T> = T | Promise<T>;

export interface RegistryActorResolutionContext {
  readonly bearerToken: string;
  readonly targetTenantId: string;
  readonly method: string;
  readonly route: string;
  readonly requestId: string;
}

export type RegistryActorResolver = (
  context: RegistryActorResolutionContext,
) => MaybePromise<RegistryActor | null>;

export interface RegistryApiTokenStore {
  listApiTokens(): MaybePromise<readonly ApiTokenRecord[]>;
  authenticate?: (
    token: string,
    now?: Date,
  ) => MaybePromise<RegistryActor | null>;
}

export interface CreateRegistryServerOptions {
  domain?: RegistryDomainPort;
  actorResolver?: RegistryActorResolver;
  tokenStore?: RegistryApiTokenStore;
  tokenService?: RegistryTokenService;
  usageLedger?: UsageLedgerPort;
  entitlements?: EntitlementServicePort;
  billingProvider?: BillingProvider;
  billingWebhookHandler?: BillingWebhookHandlerPort;
  artifactStore?: RegistryArtifactStore;
  /** Explicit migration/test escape hatch; normal HTTP releases require full Packs. */
  allowMetadataOnlyReleases?: boolean;
  readiness?: () => MaybePromise<boolean>;
  clock?: () => Date;
  bodyLimit?: number;
  /**
   * In-process depth defence for the unauthenticated public surface. `false`
   * disables it; omitting keeps conservative defaults. This is not a
   * substitute for an edge gateway on a real public deployment.
   */
  publicRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /** Independent budget for the bounded but comparatively expensive two-artifact diff. */
  semanticDiffRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /** Independent browser-login budget so public browsing cannot starve SSO. */
  authRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /** Independent billing-webhook budget so other anonymous traffic cannot starve it. */
  billingWebhookRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /**
   * Pre-authentication budget for protected API paths. It is intentionally
   * wider than anonymous budgets but still bounds invalid token/OIDC lookups.
   */
  apiRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /** Stricter pre-authentication budget for the large release-upload route. */
  releaseUploadRateLimit?:
    | false
    | {
        capacity?: number;
        refillPerSecond?: number;
        maxClients?: number;
      };
  /**
   * Exact proxy IP/CIDR allow-list used to derive `request.ip` from forwarding
   * headers. Omit when Registry is reached directly. Wildcards and /0 ranges
   * are rejected so a client cannot opt itself into the trust boundary.
   */
  trustProxy?: string | readonly string[];
  /**
   * Optional browser login (OIDC authorization-code + PKCE). Mock-IdP tested
   * engineering only; real IdP onboarding evidence remains outstanding.
   */
  browserAuth?: Omit<BrowserLoginOptions, "clock">;
}

export function createRegistryServer(
  options: CreateRegistryServerOptions = {},
): FastifyInstance {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1_024) {
    throw new Error("Registry HTTP body limit must be at least 1024 bytes");
  }

  const domain: RegistryDomainPort =
    options.domain ?? new RegistryDomainService();
  const clock = options.clock ?? (() => new Date());
  const tokenService =
    options.tokenService ?? new InMemoryRegistryTokenService(clock);
  options = { ...options, tokenService };
  const usageLedger: UsageLedgerPort = options.usageLedger ?? new UsageLedger();
  const entitlements: EntitlementServicePort =
    options.entitlements ?? new EntitlementService("off");
  const billingProvider =
    options.billingProvider ?? new UnavailableBillingProvider();
  const artifactStore =
    options.artifactStore ?? new InMemoryRegistryArtifactStore();
  const trustedProxies = normalizeRegistryTrustProxy(options.trustProxy);
  const smallJsonRouteOptions = {
    bodyLimit: Math.min(bodyLimit, SMALL_JSON_BODY_LIMIT),
  } as const;
  const billingWebhookRouteOptions = {
    bodyLimit: Math.min(bodyLimit, BILLING_WEBHOOK_BODY_LIMIT),
  } as const;
  const app = fastify({
    bodyLimit,
    logger: false,
    trustProxy: trustedProxies ?? false,
  });
  const memberMutationLocks = new Map<string, Promise<void>>();

  // Keeping the exact JSON bytes is required for webhook signature verification.
  // Every JSON route parses and validates the string explicitly below.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit },
    (_request, body, done) => done(null, body),
  );

  app.addHook("onRequest", (request, reply, done) => {
    registryRequestReplies.set(request, reply);
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    done();
  });

  const rateLimiters = {
    diff: createRequestRateLimiter(
      options.semanticDiffRateLimit,
      { capacity: 4, refillPerSecond: 0.2, maxClients: 10_000 },
      clock,
    ),
    public: createRequestRateLimiter(
      options.publicRateLimit,
      {
        capacity: 60,
        refillPerSecond: 5,
        maxClients: 10_000,
      },
      clock,
    ),
    auth: createRequestRateLimiter(
      options.authRateLimit,
      {
        capacity: 20,
        refillPerSecond: 1,
        maxClients: 10_000,
      },
      clock,
    ),
    billing: createRequestRateLimiter(
      options.billingWebhookRateLimit,
      {
        capacity: 30,
        refillPerSecond: 2,
        maxClients: 10_000,
      },
      clock,
    ),
    api: createRequestRateLimiter(
      options.apiRateLimit,
      {
        capacity: 120,
        refillPerSecond: 20,
        maxClients: 10_000,
      },
      clock,
    ),
    upload: createRequestRateLimiter(
      options.releaseUploadRateLimit,
      {
        capacity: 5,
        refillPerSecond: 0.2,
        maxClients: 10_000,
      },
      clock,
    ),
  } as const;
  if (Object.values(rateLimiters).some((limiter) => limiter !== null)) {
    app.addHook("onRequest", (request, reply, done) => {
      // Use Fastify's matched route pattern when available. The raw URL can
      // contain percent-encoded static segments (for example `%6f` for `o`),
      // while the router still resolves the protected/public route.
      const pathname =
        request.routeOptions.url || request.url.split("?")[0] || "";
      const group = requestRateLimitGroup(pathname, request.method);
      const limiter = group ? rateLimiters[group] : null;
      if (!limiter) {
        done();
        return;
      }
      const decision = limiter.check(request.ip || "unknown");
      if (decision.allowed) {
        done();
        return;
      }
      reply.header("retry-after", String(decision.retryAfterSeconds));
      sendError(
        reply,
        request,
        429,
        "rate_limited",
        "Too many requests from this client; retry later",
      );
    });
  }

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, 404, "not_found", "Route not found"),
  );
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const normalized = normalizeError(error);
    return sendError(
      reply,
      request,
      normalized.statusCode,
      normalized.code,
      normalized.message,
    );
  });

  app.get("/healthz", async (request, reply) =>
    sendSuccess(reply, request, { status: "ok" }),
  );

  app.get("/readyz", async (request, reply) => {
    const ready = (await options.readiness?.()) ?? true;
    return sendSuccess(
      reply,
      request,
      { status: ready ? "ready" : "not_ready" },
      ready ? 200 : 503,
    );
  });

  app.get("/v1/openapi.json", async (_request, reply) =>
    reply.code(200).send(OPENAPI_DOCUMENT),
  );

  app.get("/v1/me", async (request, reply) => {
    const query = MeQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      query.org_id,
      "pack:read",
      options,
      clock,
    );
    return sendSuccess(reply, request, publicActorView(actor));
  });

  app.get("/v1/orgs/:orgId/tokens", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = RegistryCollectionPageQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "token:issue",
      options,
      clock,
    );
    const page = await tokenService.listForOrganizationPage(actor, orgId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      tokens: page.items.map(publicTokenView),
      next_cursor: page.next_cursor,
    });
  });

  app.post(
    "/v1/orgs/:orgId/tokens",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, IssueTokenBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "token:issue",
        options,
        clock,
      );
      const issued = await tokenService.issue(
        actor,
        orgId,
        { scopes: body.scopes, expiresAt: body.expires_at },
        request.id,
      );
      return sendSuccess(
        reply,
        request,
        { token: issued.token, record: publicTokenView(issued.record) },
        201,
      );
    },
  );

  app.post(
    "/v1/orgs/:orgId/tokens/:tokenId/revoke",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId, tokenId } = TokenParamsSchema.parse(request.params);
      parseJsonBody(request, z.object({}).strict());
      const actor = await requireActor(
        request,
        orgId,
        "token:revoke",
        options,
        clock,
      );
      try {
        const revoked = await tokenService.revoke(
          actor,
          orgId,
          tokenId,
          request.id,
        );
        return sendSuccess(reply, request, publicTokenView(revoked));
      } catch (error) {
        if (!(error instanceof RegistryTokenNotFoundError)) throw error;
        throw new HttpRouteError(404, "not_found", "Resource not found");
      }
    },
  );

  app.get("/v1/public/packages", async (request, reply) => {
    const query = PublicSearchQuerySchema.parse(request.query);
    const page = await domain.searchPublicPackages({
      query: query.query ?? "",
      languages: query.language ?? [],
      ecosystems: query.ecosystem ?? [],
      tags: query.tag ?? [],
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      packages: page.items.map((item) =>
        publicPackageView(item, query.include === "facets"),
      ),
      next_cursor: page.next_cursor,
    });
  });

  app.get("/v1/public/package", async (request, reply) => {
    const query = PublicPackageQuerySchema.parse(request.query);
    return sendSuccess(
      reply,
      request,
      publicPackageView(await domain.getPublicPackage({ name: query.name })),
    );
  });

  app.get("/v1/public/release", async (request, reply) => {
    const query = PublicReleaseQuerySchema.parse(request.query);
    return sendSuccess(
      reply,
      request,
      publicReleaseView(
        await domain.getPublicRelease({
          package_name: query.package_name,
          version: query.version,
        }),
      ),
    );
  });

  app.get("/v1/public/releases", async (request, reply) => {
    const query = PublicReleaseListQuerySchema.parse(request.query);
    const page = await domain.listPublicReleases({
      package_name: query.package_name,
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      releases: page.items.map(publicReleaseView),
      next_cursor: page.next_cursor,
    });
  });

  app.get("/v1/public/diff", async (request, reply) => {
    const query = PublicDiffQuerySchema.parse(request.query);
    const [fromRelease, toRelease] = await Promise.all([
      domain.getPublicRelease({
        package_name: query.package_name,
        version: query.from_version,
      }),
      domain.getPublicRelease({
        package_name: query.package_name,
        version: query.to_version,
      }),
    ]);
    if (
      !isComparablePublicRelease(fromRelease) ||
      !isComparablePublicRelease(toRelease)
    ) {
      throw new HttpRouteError(404, "not_found", "Resource not found");
    }
    if (
      fromRelease.org_id !== toRelease.org_id ||
      fromRelease.package_id !== toRelease.package_id ||
      fromRelease.package_name !== query.package_name ||
      toRelease.package_name !== query.package_name ||
      fromRelease.version !== query.from_version ||
      toRelease.version !== query.to_version
    ) {
      throw storedRegistryDiffError();
    }

    try {
      const [fromArtifact, toArtifact] = await Promise.all([
        domain.getArtifact
          ? domain.getArtifact(
              fromRelease.org_id,
              fromRelease.package_name,
              fromRelease.version,
            )
          : artifactStore.get(
              fromRelease.org_id,
              fromRelease.package_name,
              fromRelease.version,
            ),
        domain.getArtifact
          ? domain.getArtifact(
              toRelease.org_id,
              toRelease.package_name,
              toRelease.version,
            )
          : artifactStore.get(
              toRelease.org_id,
              toRelease.package_name,
              toRelease.version,
            ),
      ]);
      if (!fromArtifact || !toArtifact) {
        throw new HttpRouteError(404, "not_found", "Resource not found");
      }
      if (
        !artifactMatchesRelease(fromArtifact, fromRelease) ||
        !artifactMatchesRelease(toArtifact, toRelease)
      ) {
        throw storedRegistryDiffError();
      }
      return sendSuccess(
        reply,
        request,
        diffRegistryPackArtifacts(fromArtifact, toArtifact),
      );
    } catch (error) {
      if (error instanceof HttpRouteError) throw error;
      if (error instanceof RegistryNotFoundError) {
        throw new HttpRouteError(404, "not_found", "Resource not found");
      }
      throw storedRegistryDiffError(error);
    }
  });

  app.get("/v1/public/artifact", async (request, reply) => {
    const query = PublicReleaseQuerySchema.parse(request.query);
    const release = await domain.getPublicRelease({
      package_name: query.package_name,
      version: query.version,
    });
    if (release.status === "yanked") {
      throw new HttpRouteError(
        410,
        "release_yanked",
        "Release has been yanked",
      );
    }
    const artifact = domain.getArtifact
      ? await domain.getArtifact(
          release.org_id,
          release.package_name,
          release.version,
        )
      : artifactStore.get(
          release.org_id,
          release.package_name,
          release.version,
        );
    if (!artifact) {
      throw new HttpRouteError(404, "not_found", "Resource not found");
    }
    await recordDownload(usageLedger, release, clock());
    return sendSuccess(reply, request, artifact);
  });

  app.get("/v1/orgs/:orgId/packages", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = RegistryCollectionPageQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "pack:read",
      options,
      clock,
    );
    const page = await domain.listPackagePage(actor.subjectId, {
      org_id: orgId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      packages: page.items,
      next_cursor: page.next_cursor,
    });
  });

  app.get("/v1/orgs/:orgId/package", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = PackageQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "pack:read",
      options,
      clock,
    );
    return sendSuccess(
      reply,
      request,
      await domain.getPackage(actor.subjectId, {
        org_id: orgId,
        name: query.name,
      }),
    );
  });

  app.post(
    "/v1/orgs/:orgId/packages",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, CreatePackageBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "pack:publish",
        options,
        clock,
      );
      if (body.visibility === "private") {
        const packageEntitlements = await entitlements.entitlementsFor(orgId);
        if (!packageEntitlements.privatePacks) {
          throw new HttpRouteError(
            422,
            "private_packs_not_entitled",
            "Private Packs are not enabled for this organization",
          );
        }
      }
      const packageInput = { ...body, org_id: orgId };
      const registryPackage = domain.createPackageWithContext
        ? await domain.createPackageWithContext(actor.subjectId, packageInput, {
            requestId: request.id,
            actorKind: actor.kind,
          })
        : await domain.createPackage(actor.subjectId, packageInput);
      return sendSuccess(reply, request, registryPackage, 201);
    },
  );

  app.get("/v1/orgs/:orgId/releases", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = ReleaseListQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "pack:read",
      options,
      clock,
    );
    const page = await domain.listReleasePage(actor.subjectId, {
      org_id: orgId,
      package_name: query.package_name,
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      releases: page.items,
      next_cursor: page.next_cursor,
    });
  });

  app.get("/v1/orgs/:orgId/release", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = ReleaseQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "pack:read",
      options,
      clock,
    );
    return sendSuccess(
      reply,
      request,
      await domain.getRelease(actor.subjectId, {
        org_id: orgId,
        package_name: query.package_name,
        version: query.version,
      }),
    );
  });

  app.get("/v1/orgs/:orgId/artifact", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = ReleaseQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "pack:read",
      options,
      clock,
    );
    const release = await domain.getRelease(actor.subjectId, {
      org_id: orgId,
      package_name: query.package_name,
      version: query.version,
    });
    if (release.status !== "published") {
      const yanked = release.status === "yanked";
      throw new HttpRouteError(
        yanked ? 410 : 404,
        yanked ? "release_yanked" : "not_found",
        yanked ? "Release has been yanked" : "Resource not found",
      );
    }
    const artifact = domain.getArtifact
      ? await domain.getArtifact(orgId, release.package_name, release.version)
      : artifactStore.get(orgId, release.package_name, release.version);
    if (!artifact) {
      throw new HttpRouteError(404, "not_found", "Resource not found");
    }
    await recordDownload(usageLedger, release, clock());
    return sendSuccess(reply, request, artifact);
  });

  app.post("/v1/orgs/:orgId/releases", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const body = parseJsonBody(request, SubmitReleaseBodySchema);
    const actor = await requireActor(
      request,
      orgId,
      "pack:publish",
      options,
      clock,
    );
    if (!body.pack_artifact && options.allowMetadataOnlyReleases !== true) {
      throw new HttpRouteError(
        422,
        "artifact_required",
        "A verified Pack artifact is required",
      );
    }
    const registryPackage = await requireEntitledRegistryPackage(
      domain,
      entitlements,
      actor.subjectId,
      orgId,
      body.package_name,
    );
    let packDiscovery: PublicPackDiscoveryDocument | undefined;
    if (body.pack_artifact) {
      try {
        withMaterializedRegistryPackArtifact(body.pack_artifact, (verified) => {
          if (
            verified.store.manifest.visibility !== registryPackage.visibility
          ) {
            throw new Error(
              "Pack manifest visibility must match its Registry package",
            );
          }
          packDiscovery = buildPublicPackDiscoveryDocument(verified);
        });
      } catch (error) {
        if (isNodeSystemError(error)) throw error;
        throw new HttpRouteError(
          400,
          "invalid_artifact",
          "Pack artifact verification failed",
        );
      }
      try {
        if (domain.assertArtifactCompatible) {
          await domain.assertArtifactCompatible(orgId, body.pack_artifact);
        } else {
          artifactStore.assertCompatible(orgId, body.pack_artifact);
        }
      } catch (error) {
        if (
          !(error instanceof RegistryArtifactConflictError) &&
          !(error instanceof RegistryConflictError)
        ) {
          throw error;
        }
        throw new HttpRouteError(
          409,
          "artifact_conflict",
          "An immutable artifact already exists for this version",
        );
      }
    }
    const { pack_artifact: packArtifact, ...releaseInput } = body;
    const completeInput = { ...releaseInput, org_id: orgId };
    const release =
      packArtifact && domain.submitArtifactRelease
        ? await domain.submitArtifactRelease(
            actor.subjectId,
            completeInput,
            packArtifact,
            packDiscovery!,
            { requestId: request.id, actorKind: actor.kind },
          )
        : await domain.submitRelease(
            actor.subjectId,
            completeInput,
            packDiscovery,
          );
    if (packArtifact && !domain.submitArtifactRelease) {
      artifactStore.put(orgId, packArtifact);
    }
    return sendSuccess(reply, request, release, 201);
  });

  app.post(
    "/v1/orgs/:orgId/releases/approve",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, ReviewReleaseBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "pack:deprecate",
        options,
        clock,
      );
      await requireEntitledRegistryPackage(
        domain,
        entitlements,
        actor.subjectId,
        orgId,
        body.package_name,
      );
      const releaseInput = { ...body, org_id: orgId };
      const release = domain.approveReleaseWithContext
        ? await domain.approveReleaseWithContext(
            actor.subjectId,
            releaseInput,
            {
              requestId: request.id,
              actorKind: actor.kind,
            },
          )
        : await domain.approveRelease(actor.subjectId, releaseInput);
      return sendSuccess(reply, request, release);
    },
  );

  app.post(
    "/v1/orgs/:orgId/releases/reject",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, RejectReleaseBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "pack:deprecate",
        options,
        clock,
      );
      const releaseInput = { ...body, org_id: orgId };
      const release = domain.rejectReleaseWithContext
        ? await domain.rejectReleaseWithContext(actor.subjectId, releaseInput, {
            requestId: request.id,
            actorKind: actor.kind,
          })
        : await domain.rejectRelease(actor.subjectId, releaseInput);
      return sendSuccess(reply, request, release);
    },
  );

  app.post(
    "/v1/orgs/:orgId/releases/yank",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, YankReleaseBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "pack:deprecate",
        options,
        clock,
      );
      const releaseInput = { ...body, org_id: orgId };
      const release = domain.yankReleaseWithContext
        ? await domain.yankReleaseWithContext(actor.subjectId, releaseInput, {
            requestId: request.id,
            actorKind: actor.kind,
          })
        : await domain.yankRelease(actor.subjectId, releaseInput);
      return sendSuccess(reply, request, release);
    },
  );

  app.get("/v1/orgs/:orgId/members", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = RegistryCollectionPageQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "member:read",
      options,
      clock,
    );
    const page = await domain.listMemberPage(actor.subjectId, {
      org_id: orgId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      members: page.items,
      next_cursor: page.next_cursor,
    });
  });

  app.post(
    "/v1/orgs/:orgId/members",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, AddMemberBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "member:manage",
        options,
        clock,
      );
      if (
        body.role === "owner" &&
        (actor.kind !== "human" || actor.role !== "owner")
      ) {
        throw new HttpRouteError(
          403,
          "forbidden",
          "Only an owner may grant the owner role",
        );
      }
      const memberInput = { ...body, org_id: orgId };
      let member;
      if (domain.addMemberWithContext) {
        const { maxSeats } = await entitlements.entitlementsFor(orgId);
        member = await domain.addMemberWithContext(
          actor.subjectId,
          memberInput,
          {
            requestId: request.id,
            actorKind: actor.kind,
            maxSeats,
          },
        );
      } else {
        member = await withKeyedMutationLock(
          memberMutationLocks,
          orgId,
          async () => {
            const currentMembers = await domain.listMembers(actor.subjectId, {
              org_id: orgId,
            });
            if (!currentMembers.some((item) => item.user_id === body.user_id)) {
              try {
                await entitlements.assertSeats(
                  orgId,
                  currentMembers.length + 1,
                );
              } catch (error) {
                if (!(error instanceof SeatLimitExceededError)) throw error;
                throw new HttpRouteError(
                  422,
                  "seat_limit_exceeded",
                  "Seat limit exceeded",
                );
              }
            }
            return domain.addMember(actor.subjectId, memberInput);
          },
        );
      }
      return sendSuccess(reply, request, member, 201);
    },
  );

  app.post(
    "/v1/orgs/:orgId/members/provision",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, ProvisionExternalMemberBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "member:manage",
        options,
        clock,
      );
      if (actor.kind !== "human") {
        throw new HttpRouteError(
          403,
          "forbidden",
          "Verified human identity required",
        );
      }
      if (body.role === "owner" && actor.role !== "owner") {
        throw new HttpRouteError(
          403,
          "forbidden",
          "Only an owner may grant the owner role",
        );
      }
      if (!domain.provisionExternalMemberWithContext) {
        throw new HttpRouteError(
          501,
          "not_supported",
          "External identity provisioning is not configured",
        );
      }
      const { maxSeats } = await entitlements.entitlementsFor(orgId);
      const member = await domain.provisionExternalMemberWithContext(
        actor.subjectId,
        {
          ...body,
          org_id: orgId,
          provider: actor.identityProvider,
          identity_issuer: actor.identityIssuer,
        },
        {
          requestId: request.id,
          actorKind: actor.kind,
          maxSeats,
        },
      );
      return sendSuccess(reply, request, member, 201);
    },
  );

  app.post(
    "/v1/orgs/:orgId/members/:userId/role",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId, userId } = MemberParamsSchema.parse(request.params);
      const body = parseJsonBody(request, UpdateMemberBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "member:manage",
        options,
        clock,
      );
      if (
        body.role === "owner" &&
        (actor.kind !== "human" || actor.role !== "owner")
      ) {
        throw new HttpRouteError(
          403,
          "forbidden",
          "Only an owner may grant the owner role",
        );
      }
      const input = { org_id: orgId, user_id: userId, role: body.role };
      const member = domain.updateMemberRoleWithContext
        ? await domain.updateMemberRoleWithContext(actor.subjectId, input, {
            requestId: request.id,
            actorKind: actor.kind,
          })
        : await domain.updateMemberRole(actor.subjectId, input);
      if (!domain.managesMemberTokenRevocation) {
        await tokenService.revokeForSubject(actor, orgId, userId, request.id);
      }
      return sendSuccess(reply, request, member);
    },
  );

  app.post(
    "/v1/orgs/:orgId/members/:userId/remove",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId, userId } = MemberParamsSchema.parse(request.params);
      const body = parseJsonBody(request, RemoveMemberBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "member:manage",
        options,
        clock,
      );
      const input = { org_id: orgId, user_id: userId, reason: body.reason };
      const member = domain.removeMemberWithContext
        ? await domain.removeMemberWithContext(actor.subjectId, input, {
            requestId: request.id,
            actorKind: actor.kind,
          })
        : await domain.removeMember(actor.subjectId, input);
      if (!domain.managesMemberTokenRevocation) {
        await tokenService.revokeForSubject(actor, orgId, userId, request.id);
      }
      return sendSuccess(reply, request, member);
    },
  );

  app.get("/v1/orgs/:orgId/audit", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = RegistryCollectionPageQuerySchema.parse(request.query);
    const actor = await requireActor(
      request,
      orgId,
      "audit:read",
      options,
      clock,
    );
    const page = await domain.listAuditEventPage(actor.subjectId, {
      org_id: orgId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return sendSuccess(reply, request, {
      events: page.items,
      next_cursor: page.next_cursor,
    });
  });

  app.get("/v1/orgs/:orgId/usage/summary", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    const query = UsageSummaryQuerySchema.parse(request.query);
    await requireActor(request, orgId, "audit:read", options, clock);
    return sendSuccess(
      reply,
      request,
      await usageLedger.summary({ orgId, packageName: query.package_name }),
    );
  });

  app.post(
    "/v1/orgs/:orgId/usage/events",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, UsageReportBodySchema);
      const actor = await requireActor(
        request,
        orgId,
        "pack:read",
        options,
        clock,
      );
      // Exact release lookup is tenant-scoped and prevents attribution to a
      // package version that was never approved for this organization.
      const release = await domain.getRelease(actor.subjectId, {
        org_id: orgId,
        package_name: body.package_name,
        version: body.package_version,
      });
      if (release.status !== "published" && release.status !== "yanked") {
        throw new HttpRouteError(404, "not_found", "Resource not found");
      }
      const event = UsageEventSchema.parse({ ...body, org_id: orgId });
      let quota: { used: number; duplicate: boolean };
      let recorded: {
        event: z.infer<typeof UsageEventSchema>;
        created: boolean;
      };
      if (usageLedger.recordWithQuota) {
        try {
          const result = await usageLedger.recordWithQuota(event);
          quota = result.quota;
          recorded = { event: result.event, created: result.created };
        } catch (error) {
          if (error instanceof UsageQuotaExceededError) {
            throw new HttpRouteError(
              422,
              "quota_exceeded",
              "Usage quota exceeded",
            );
          }
          if (error instanceof UsageConflictError) {
            throw new HttpRouteError(
              409,
              "conflict",
              "Usage event id already exists with different data",
            );
          }
          throw error;
        }
      } else {
        try {
          quota = await entitlements.consume(orgId, 1, {
            idempotencyKey: event.event_id,
            occurredAt: clock().toISOString(),
          });
        } catch (error) {
          if (error instanceof UsageQuotaExceededError) {
            throw new HttpRouteError(
              422,
              "quota_exceeded",
              "Usage quota exceeded",
            );
          }
          throw error;
        }
        try {
          recorded = await usageLedger.record(event);
        } catch (error) {
          if (error instanceof UsageConflictError) {
            throw new HttpRouteError(
              409,
              "conflict",
              "Usage event id already exists with different data",
            );
          }
          throw error;
        }
      }
      return sendSuccess(
        reply,
        request,
        { ...recorded, quota },
        recorded.created ? 201 : 200,
      );
    },
  );

  app.get("/v1/orgs/:orgId/entitlements", async (request, reply) => {
    const { orgId } = OrganizationParamsSchema.parse(request.params);
    await requireActor(request, orgId, "pack:read", options, clock);
    return sendSuccess(reply, request, {
      billing_mode: entitlements.billingMode,
      plan: await entitlements.planFor(orgId),
      entitlements: await entitlements.entitlementsFor(orgId),
    });
  });

  app.post(
    "/v1/orgs/:orgId/billing/checkout",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      const body = parseJsonBody(request, CheckoutBodySchema);
      await requireActor(request, orgId, "billing:manage", options, clock);
      return sendSuccess(
        reply,
        request,
        await billingProvider.createCheckout(orgId, body.plan),
        201,
      );
    },
  );

  app.post(
    "/v1/orgs/:orgId/billing/portal",
    smallJsonRouteOptions,
    async (request, reply) => {
      const { orgId } = OrganizationParamsSchema.parse(request.params);
      parseJsonBody(request, z.object({}).strict());
      await requireActor(request, orgId, "billing:manage", options, clock);
      return sendSuccess(
        reply,
        request,
        await billingProvider.createPortal(orgId),
        201,
      );
    },
  );

  app.post(
    "/v1/billing/webhook",
    billingWebhookRouteOptions,
    async (request, reply) => {
      const handler = options.billingWebhookHandler;
      if (!handler) {
        throw new HttpRouteError(
          503,
          "billing_unavailable",
          "Billing webhook is not configured",
        );
      }
      const signature = singleHeader(request.headers, "x-billing-signature");
      const body = requireRawJsonBody(request);
      if (!signature) {
        throw new HttpRouteError(
          400,
          "invalid_webhook",
          "Invalid billing webhook",
        );
      }
      try {
        return sendSuccess(
          reply,
          request,
          await handler.handle(body, signature, clock()),
        );
      } catch (error) {
        if (!(error instanceof BillingWebhookRejectedError)) throw error;
        throw new HttpRouteError(
          400,
          "invalid_webhook",
          "Invalid billing webhook",
        );
      }
    },
  );

  if (options.browserAuth) {
    browserSessionAuthenticators.set(
      options,
      registerBrowserAuth(app, { ...options.browserAuth, clock }),
    );
  }
  registerRegistryWeb(app);

  return app;
}

async function requireActor(
  request: FastifyRequest,
  targetTenantId: string,
  permission: RegistryPermission,
  options: CreateRegistryServerOptions,
  clock: () => Date,
): Promise<RegistryActor> {
  // Protected responses can contain tenant-scoped identity, authorization,
  // and mutation results. Set this before authentication so successes and all
  // auth/permission failures are equally non-cacheable for bearer and cookie.
  const reply = registryRequestReplies.get(request);
  if (reply && !reply.sent) reply.header("cache-control", "no-store");
  let actor: RegistryActor | null | undefined;
  // Header presence selects the bearer path conclusively. A malformed or
  // rejected Authorization value must never fall back to a stronger cookie.
  if (request.headers.authorization !== undefined) {
    const bearerToken = extractBearerToken(request.headers.authorization);
    if (!bearerToken) {
      throw new HttpRouteError(401, "unauthorized", "Authentication required");
    }
    const context: RegistryActorResolutionContext = {
      bearerToken,
      targetTenantId,
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      requestId: request.id,
    };
    actor = await options.actorResolver?.(context);
    const tokenStores: RegistryApiTokenStore[] = [];
    if (options.tokenStore) tokenStores.push(options.tokenStore);
    if (options.tokenService && options.tokenService !== options.tokenStore) {
      tokenStores.push(options.tokenService);
    }
    for (const tokenStore of tokenStores) {
      if (actor) break;
      actor = tokenStore.authenticate
        ? await tokenStore.authenticate(bearerToken, clock())
        : authenticateApiToken(
            bearerToken,
            await tokenStore.listApiTokens(),
            clock(),
          );
    }
  } else {
    actor = await browserSessionAuthenticators
      .get(options)
      ?.authenticate(request, reply);
  }
  if (!actor) {
    throw new HttpRouteError(401, "unauthorized", "Authentication required");
  }
  assertTenantAuthorized(actor, targetTenantId, permission);
  if (!z.string().uuid().safeParse(actor.subjectId).success) {
    throw new HttpRouteError(401, "unauthorized", "Authentication required");
  }
  return actor;
}

async function withKeyedMutationLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  if (header.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = header.slice(7);
  return isRegistryBearerToken(token) ? token : null;
}

function isNodeSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function parseJsonBody<T extends z.ZodTypeAny>(
  request: FastifyRequest,
  schema: T,
): z.output<T> {
  const raw = requireRawJsonBody(request);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpRouteError(
      400,
      "invalid_json",
      "Request body must be valid JSON",
    );
  }
  return schema.parse(value);
}

function requireRawJsonBody(request: FastifyRequest): string {
  if (typeof request.body !== "string") {
    throw new HttpRouteError(
      400,
      "invalid_json",
      "Request body must be a JSON object",
    );
  }
  return request.body;
}

function publicActorView(actor: RegistryActor): Record<string, unknown> {
  if (actor.kind === "human") {
    return {
      kind: actor.kind,
      tenant_id: actor.tenantId,
      subject_id: actor.subjectId,
      role: actor.role,
      identity_provider: actor.identityProvider,
    };
  }
  return {
    kind: actor.kind,
    tenant_id: actor.tenantId,
    subject_id: actor.subjectId,
    token_id: actor.tokenId,
    scopes: actor.scopes,
  };
}

function publicTokenView(record: ApiTokenRecord): Record<string, unknown> {
  return {
    token_id: record.tokenId,
    prefix: record.prefix,
    scopes: record.scopes,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
  };
}

async function requireEntitledRegistryPackage(
  domain: RegistryDomainPort,
  entitlements: EntitlementServicePort,
  actorId: string,
  orgId: string,
  packageName: string,
): Promise<RegistryPackage> {
  const registryPackage = await domain.getPackage(actorId, {
    org_id: orgId,
    name: packageName,
  });
  if (
    registryPackage.visibility === "private" &&
    !(await entitlements.entitlementsFor(orgId)).privatePacks
  ) {
    throw new HttpRouteError(
      422,
      "private_packs_not_entitled",
      "Private Packs are not enabled for this organization",
    );
  }
  return registryPackage;
}

function publicPackageView(
  registryPackage: RegistryPackage | PublicRegistryPackageSearchHit,
  includeFacets = false,
): Record<string, unknown> {
  const legacy = {
    name: registryPackage.name,
    visibility: registryPackage.visibility,
    created_at: registryPackage.created_at,
  };
  if (!includeFacets || !("discovery" in registryPackage)) return legacy;
  return {
    ...legacy,
    latest_version: registryPackage.latest_version,
    discovery_available: registryPackage.discovery_available,
    description: registryPackage.discovery.description,
    lesson_count: registryPackage.discovery.lesson_count,
    facets: {
      languages: registryPackage.discovery.languages,
      ecosystems: registryPackage.discovery.ecosystems,
      tags: registryPackage.discovery.tags,
    },
  };
}

function publicReleaseView(
  release: RegistryRelease | RegistryPublicRelease,
): Record<string, unknown> {
  return {
    package_name: release.package_name,
    version: release.version,
    artifact: release.artifact,
    status: release.status,
    approval_count:
      "approval_count" in release
        ? release.approval_count
        : release.approvals.length,
    published_at: release.published_at,
    yanked_at: release.yanked_at,
    yank_reason: release.yank_reason,
  };
}

function isComparablePublicRelease(
  release: RegistryRelease | RegistryPublicRelease,
): boolean {
  return release.status === "published" || release.status === "yanked";
}

function artifactMatchesRelease(
  artifact: RegistryPackArtifact,
  release: Pick<RegistryRelease, "artifact" | "package_name" | "version">,
): boolean {
  return (
    artifact.name === release.package_name &&
    artifact.version === release.version &&
    artifact.integrity === release.artifact.integrity
  );
}

function storedRegistryDiffError(cause?: unknown): Error {
  return new Error(
    "Stored Registry semantic diff input failed verification",
    cause === undefined ? undefined : { cause },
  );
}

async function recordDownload(
  usageLedger: UsageLedgerPort,
  release: Pick<RegistryRelease, "org_id" | "package_name" | "version">,
  occurredAt: Date,
): Promise<void> {
  await usageLedger.record({
    event_id: `download:${randomUUID()}`,
    occurred_at: occurredAt.toISOString(),
    kind: "download",
    consent: "server-observed-download",
    package_name: release.package_name,
    package_version: release.version,
    org_id: release.org_id,
    lesson_id: null,
    outcome: null,
  });
}

const PUBLIC_RATE_LIMITED_EXACT_PATHS = new Set([
  "/",
  "/app.css",
  "/app.js",
  "/pitlore-mark.svg",
  "/v1/openapi.json",
]);

type RequestRateLimitGroup =
  | "diff"
  | "public"
  | "auth"
  | "billing"
  | "api"
  | "upload";
type RequestRateLimitOptions = NonNullable<
  Exclude<CreateRegistryServerOptions["publicRateLimit"], false>
>;

function createRequestRateLimiter(
  configured: false | RequestRateLimitOptions | undefined,
  defaults: Required<RequestRateLimitOptions>,
  clock: () => Date,
): PublicRateLimiter | null {
  if (configured === false) return null;
  return new PublicRateLimiter({
    capacity: configured?.capacity ?? defaults.capacity,
    refillPerSecond: configured?.refillPerSecond ?? defaults.refillPerSecond,
    maxClients: configured?.maxClients ?? defaults.maxClients,
    clock,
  });
}

function requestRateLimitGroup(
  pathname: string,
  method: string,
): RequestRateLimitGroup | null {
  if (pathname === "/v1/billing/webhook") return "billing";
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return "auth";
  if (
    (method === "GET" || method === "HEAD") &&
    pathname === "/v1/public/diff"
  ) {
    return "diff";
  }
  if (method === "POST" && pathname === "/v1/orgs/:orgId/releases") {
    return "upload";
  }
  if (pathname === "/v1/me" || pathname.startsWith("/v1/orgs/")) return "api";
  if (
    PUBLIC_RATE_LIMITED_EXACT_PATHS.has(pathname) ||
    pathname === "/v1/public" ||
    pathname.startsWith("/v1/public/")
  ) {
    return "public";
  }
  return null;
}

/** Validate the forwarding-header trust boundary before handing it to Fastify. */
export function normalizeRegistryTrustProxy(
  configured: string | readonly string[] | undefined,
): string[] | undefined {
  if (configured === undefined) return undefined;
  const source = typeof configured === "string" ? [configured] : configured;
  const entries = source.flatMap((value) => value.split(","));
  if (entries.length < 1 || entries.length > 32) {
    throw new Error(
      "Registry trusted proxy allow-list must contain 1 to 32 entries",
    );
  }
  const normalized: string[] = [];
  for (const untrimmed of entries) {
    const entry = untrimmed.trim();
    if (entry.length === 0 || entry.length > 80 || entry.includes("%")) {
      throw new Error(
        "Registry trusted proxy entries must be IP addresses or CIDR ranges",
      );
    }
    const slash = entry.lastIndexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) {
      throw new Error(
        "Registry trusted proxy entries must be IP addresses or CIDR ranges",
      );
    }
    if (slash !== -1) {
      const prefixText = entry.slice(slash + 1);
      const prefix = Number(prefixText);
      const maximum = family === 4 ? 32 : 128;
      if (
        !/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText) ||
        !Number.isSafeInteger(prefix) ||
        prefix < 1 ||
        prefix > maximum
      ) {
        throw new Error(
          "Registry trusted proxy CIDR prefix must be bounded and cannot be /0",
        );
      }
    }
    if (!normalized.includes(entry)) normalized.push(entry);
  }
  if (normalized.length === 0) {
    throw new Error("Registry trusted proxy allow-list cannot be empty");
  }
  return normalized;
}

function sendSuccess(
  reply: FastifyReply,
  request: FastifyRequest,
  data: unknown,
  statusCode = 200,
): FastifyReply {
  return reply.code(statusCode).send({ data, request_id: request.id });
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({
    error: { code, message, request_id: request.id },
  });
}

class HttpRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpRouteError";
  }
}

function normalizeError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (error instanceof HttpRouteError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof BrowserSessionCsrfError) {
    return {
      statusCode: 403,
      code: "csrf_rejected",
      message: "Browser session request was rejected",
    };
  }
  if (error instanceof RegistryAuthorizationError) {
    if (error.code === "tenant_mismatch") {
      return {
        statusCode: 404,
        code: "not_found",
        message: "Resource not found",
      };
    }
    return { statusCode: 403, code: "forbidden", message: "Action forbidden" };
  }
  if (error instanceof RegistryNotFoundError) {
    return {
      statusCode: 404,
      code: "not_found",
      message: "Resource not found",
    };
  }
  if (error instanceof RegistryForbiddenError) {
    return { statusCode: 403, code: "forbidden", message: "Action forbidden" };
  }
  if (error instanceof RegistryConflictError) {
    return { statusCode: 409, code: "conflict", message: "Resource conflict" };
  }
  if (error instanceof RegistryTransitionError) {
    return {
      statusCode: 409,
      code: "invalid_state",
      message: "Invalid state transition",
    };
  }
  if (error instanceof RegistrySeatLimitError) {
    return {
      statusCode: 422,
      code: "seat_limit_exceeded",
      message: "Seat limit exceeded",
    };
  }
  if (error instanceof BillingUnavailableError) {
    return {
      statusCode: 503,
      code: "billing_unavailable",
      message: "Billing provider is not configured",
    };
  }
  if (error instanceof IdentityProviderUnavailableError) {
    return {
      statusCode: 503,
      code: "identity_unavailable",
      message: "Identity provider is temporarily unavailable",
    };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      statusCode: 400,
      code: "validation_error",
      message: "Request validation failed",
    };
  }
  const statusCode =
    typeof error === "object" && error !== null
      ? Number((error as { statusCode?: number }).statusCode)
      : Number.NaN;
  if (statusCode === 413) {
    return {
      statusCode: 413,
      code: "body_too_large",
      message: "Request body is too large",
    };
  }
  if (statusCode === 415) {
    return {
      statusCode: 415,
      code: "unsupported_media_type",
      message: "Unsupported media type",
    };
  }
  return {
    statusCode: 500,
    code: "internal_error",
    message: "Internal server error",
  };
}

function singleHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? undefined : value;
}

const OPENAPI_ORG_PARAMETER = Object.freeze({
  name: "orgId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const OPENAPI_PUBLIC_LIMIT_PARAMETER = Object.freeze({
  name: "limit",
  in: "query",
  required: false,
  schema: {
    type: "integer",
    minimum: 1,
    maximum: MAX_PUBLIC_REGISTRY_PAGE_SIZE,
    default: DEFAULT_PUBLIC_REGISTRY_PAGE_SIZE,
  },
});
const OPENAPI_PUBLIC_CURSOR_PARAMETER = Object.freeze({
  name: "cursor",
  in: "query",
  required: false,
  description: "Opaque cursor returned as next_cursor by the previous page",
  schema: {
    type: "string",
    minLength: 1,
    maxLength: MAX_PUBLIC_REGISTRY_CURSOR_LENGTH,
  },
});

function openApiOperation(
  summary: string,
  options: { authenticated?: boolean; status?: string } = {},
) {
  return {
    summary,
    ...(options.authenticated
      ? { security: [{ bearerAuth: [] as string[] }] }
      : {}),
    responses: {
      [options.status ?? "200"]: { description: "Success" },
      ...(options.authenticated
        ? { "401": { description: "Authentication required" } }
        : {}),
    },
  };
}

const OPENAPI_DOCUMENT = Object.freeze({
  openapi: "3.1.0",
  info: { title: "PitLore Registry API", version: "0.1.0" },
  paths: {
    "/healthz": { get: openApiOperation("Liveness probe") },
    "/readyz": { get: openApiOperation("Readiness probe") },
    "/v1/me": {
      get: openApiOperation("Current Registry actor", { authenticated: true }),
    },
    "/v1/orgs/{orgId}/tokens": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: {
        ...openApiOperation("List scoped API tokens", { authenticated: true }),
        parameters: [
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
      post: openApiOperation("Issue a scoped API token", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/tokens/{tokenId}/revoke": {
      parameters: [
        OPENAPI_ORG_PARAMETER,
        {
          name: "tokenId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      post: openApiOperation("Revoke a scoped API token", {
        authenticated: true,
      }),
    },
    "/v1/public/packages": {
      get: {
        ...openApiOperation("Search public Packs"),
        parameters: [
          {
            name: "query",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 128 },
          },
          ...["language", "ecosystem", "tag"].map((name) => ({
            name,
            in: "query",
            required: false,
            description: "Repeat up to four values; OR within one facet",
            style: "form",
            explode: true,
            schema: {
              type: "array",
              maxItems: 4,
              items: { type: "string", maxLength: 256 },
            },
          })),
          {
            name: "include",
            in: "query",
            required: false,
            description: "Opt in to bounded verified discovery metadata",
            schema: { type: "string", enum: ["facets"] },
          },
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
    },
    "/v1/public/package": { get: openApiOperation("Read a public Pack") },
    "/v1/public/release": {
      get: openApiOperation("Read a published Pack release"),
    },
    "/v1/public/releases": {
      get: {
        ...openApiOperation("List published and yanked Pack releases"),
        parameters: [
          {
            name: "package_name",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
    },
    "/v1/public/diff": {
      get: {
        ...openApiOperation("Compare two published or yanked Pack releases"),
        parameters: [
          {
            name: "package_name",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
          {
            name: "from_version",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "to_version",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
    "/v1/public/artifact": {
      get: openApiOperation("Download a published Pack artifact"),
    },
    "/v1/orgs/{orgId}/packages": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: {
        ...openApiOperation("List organization Packs", { authenticated: true }),
        parameters: [
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
      post: openApiOperation("Create an organization Pack", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/releases": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: {
        ...openApiOperation("List organization releases", {
          authenticated: true,
        }),
        parameters: [
          {
            name: "package_name",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
      post: openApiOperation("Submit an immutable release", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/artifact": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: openApiOperation("Download an authorized Pack artifact", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/releases/approve": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Approve a pending release", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/releases/reject": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Reject a pending release", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/releases/yank": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Yank a published release", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/members": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: {
        ...openApiOperation("List organization members", {
          authenticated: true,
        }),
        parameters: [
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
      post: openApiOperation("Add an organization member", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/members/provision": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation(
        "Provision an external identity as an organization member",
        {
          authenticated: true,
          status: "201",
        },
      ),
    },
    "/v1/orgs/{orgId}/members/{userId}/role": {
      parameters: [
        OPENAPI_ORG_PARAMETER,
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      post: openApiOperation("Change an organization member role", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/members/{userId}/remove": {
      parameters: [
        OPENAPI_ORG_PARAMETER,
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      post: openApiOperation("Remove an organization member", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/audit": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: {
        ...openApiOperation("Read audit events", { authenticated: true }),
        parameters: [
          OPENAPI_PUBLIC_LIMIT_PARAMETER,
          OPENAPI_PUBLIC_CURSOR_PARAMETER,
        ],
      },
    },
    "/v1/orgs/{orgId}/usage/events": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Report opt-in usage", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/usage/summary": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: openApiOperation("Read privacy-safe usage aggregates", {
        authenticated: true,
      }),
    },
    "/v1/orgs/{orgId}/entitlements": {
      parameters: [OPENAPI_ORG_PARAMETER],
      get: openApiOperation("Read plan entitlements", { authenticated: true }),
    },
    "/v1/billing/webhook": {
      post: openApiOperation("Receive signed billing events"),
    },
    "/v1/orgs/{orgId}/billing/checkout": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Create a billing-provider checkout session", {
        authenticated: true,
        status: "201",
      }),
    },
    "/v1/orgs/{orgId}/billing/portal": {
      parameters: [OPENAPI_ORG_PARAMETER],
      post: openApiOperation("Create a billing-provider portal session", {
        authenticated: true,
        status: "201",
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
});
