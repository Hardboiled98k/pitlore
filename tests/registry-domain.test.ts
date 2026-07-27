import { describe, expect, it } from "vitest";
import {
  CreateRegistryPackageInputSchema,
  InMemoryRegistryRepository,
  RegisterRegistryUserInputSchema,
  RegistryConflictError,
  RegistryDomainService,
  RegistryForbiddenError,
  RegistryNotFoundError,
  RegistryReleaseSchema,
  RegistryTransitionError,
  SubmitRegistryReleaseInputSchema,
  type RegistryArtifact,
  type RegistryOrganization,
  type RegistryUser,
} from "../src/registry-domain.js";
import type { PublicPackDiscoveryDocument } from "../src/registry-search.js";

describe("Phase 3 Registry domain", () => {
  it("enforces strict schemas and the organization package namespace", () => {
    const { service, owner, organization } = makeRegistry();

    expect(() =>
      RegisterRegistryUserInputSchema.parse({
        email: "valid@example.com",
        display_name: "Valid",
        admin: true,
      }),
    ).toThrow();
    expect(() =>
      SubmitRegistryReleaseInputSchema.parse({
        org_id: organization.id,
        package_name: "acme/core",
        version: "v1.0.0",
        artifact: artifact(),
      }),
    ).toThrow();
    for (const sourceUrl of [
      "http://example.com/acme/core.git",
      "https://user:secret@example.com/acme/core.git",
      "https://example.com/acme/core.git?access_token=secret",
      "https://example.com/acme/core.git#access_token=secret",
      "https://example.com/acme/core.git?",
      "https://example.com/acme/core.git#",
    ]) {
      expect(() =>
        SubmitRegistryReleaseInputSchema.parse({
          org_id: organization.id,
          package_name: "acme/core",
          version: "1.0.0",
          artifact: artifact({ source_url: sourceUrl }),
        }),
      ).toThrow(/credential-free HTTPS/);
    }
    expect(() =>
      service.createPackage(owner.id, {
        org_id: organization.id,
        name: "other/core",
        visibility: "private",
      }),
    ).toThrow(/organization namespace acme/);
    expect(() =>
      CreateRegistryPackageInputSchema.parse({
        org_id: organization.id,
        name: "acme/core",
        visibility: "private",
        unexpected: "field",
      }),
    ).toThrow();
  });

  it("publishes only after two distinct non-submitter admins approve", () => {
    const fixture = makeRegistry();
    const submitted = fixture.service.submitRelease(fixture.submitter.id, {
      org_id: fixture.organization.id,
      package_name: fixture.registryPackage.name,
      version: "1.0.0",
      artifact: artifact(),
    });
    expect(submitted.status).toBe("pending");
    expect(submitted.approvals).toEqual([]);

    expect(() =>
      fixture.service.approveRelease(fixture.submitter.id, releaseIdentity(fixture)),
    ).toThrow(RegistryForbiddenError);

    const first = fixture.service.approveRelease(
      fixture.owner.id,
      releaseIdentity(fixture),
    );
    expect(first.status).toBe("pending");
    expect(first.approvals.map((approval) => approval.user_id)).toEqual([
      fixture.owner.id,
    ]);
    expect(() =>
      fixture.service.approveRelease(fixture.owner.id, releaseIdentity(fixture)),
    ).toThrow(RegistryConflictError);

    const published = fixture.service.approveRelease(
      fixture.reviewer.id,
      releaseIdentity(fixture),
    );
    expect(published.status).toBe("published");
    expect(published.approvals.map((approval) => approval.user_id)).toEqual([
      fixture.owner.id,
      fixture.reviewer.id,
    ]);
    expect(published.published_at).not.toBeNull();

    expect(() =>
      fixture.service.approveRelease(fixture.secondReviewer.id, releaseIdentity(fixture)),
    ).toThrow(RegistryTransitionError);
  });

  it("supports pending to rejected and published to yanked terminal transitions", () => {
    const fixture = makeRegistry();
    fixture.service.submitRelease(fixture.submitter.id, {
      org_id: fixture.organization.id,
      package_name: fixture.registryPackage.name,
      version: "1.1.0",
      artifact: artifact({ fill: 2 }),
    });
    const rejected = fixture.service.rejectRelease(fixture.owner.id, {
      ...releaseIdentity(fixture, "1.1.0"),
      reason: "Artifact provenance needs correction",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      rejection_reason: "Artifact provenance needs correction",
    });
    expect(() =>
      fixture.service.approveRelease(
        fixture.reviewer.id,
        releaseIdentity(fixture, "1.1.0"),
      ),
    ).toThrow(RegistryTransitionError);
    expect(() =>
      fixture.service.yankRelease(fixture.owner.id, {
        ...releaseIdentity(fixture, "1.1.0"),
        reason: "Cannot yank an unpublished release",
      }),
    ).toThrow(RegistryTransitionError);

    publish(fixture, "2.0.0", artifact({ fill: 3 }));
    const yanked = fixture.service.yankRelease(fixture.reviewer.id, {
      ...releaseIdentity(fixture, "2.0.0"),
      reason: "Critical detector false positive",
    });
    expect(yanked).toMatchObject({
      status: "yanked",
      yank_reason: "Critical detector false positive",
    });
    expect(yanked.published_at).not.toBeNull();
    expect(() =>
      fixture.service.yankRelease(fixture.owner.id, {
        ...releaseIdentity(fixture, "2.0.0"),
        reason: "Repeat yank",
      }),
    ).toThrow(RegistryTransitionError);
  });

  it("keeps package names and release artifacts immutable for all returned snapshots", () => {
    const fixture = makeRegistry();
    const originalArtifact = artifact({ fill: 4 });
    const submitted = fixture.service.submitRelease(fixture.submitter.id, {
      org_id: fixture.organization.id,
      package_name: fixture.registryPackage.name,
      version: "3.0.0",
      artifact: originalArtifact,
    });

    fixture.registryPackage.name = "acme/changed";
    submitted.version = "9.9.9";
    submitted.artifact.integrity = artifact({ fill: 9 }).integrity;

    expect(
      fixture.service.getPackage(fixture.owner.id, {
        org_id: fixture.organization.id,
        name: "acme/core",
      }).name,
    ).toBe("acme/core");
    expect(
      fixture.service.getRelease(fixture.owner.id, {
        ...releaseIdentity(fixture, "3.0.0"),
      }),
    ).toMatchObject({
      version: "3.0.0",
      artifact: originalArtifact,
      status: "pending",
    });

    expect(() =>
      fixture.service.submitRelease(fixture.submitter.id, {
        org_id: fixture.organization.id,
        package_name: "acme/core",
        version: "3.0.0",
        artifact: artifact({ fill: 5 }),
      }),
    ).toThrow(/immutable and already exists/);
    expect(
      fixture.service.listReleases(fixture.owner.id, {
        org_id: fixture.organization.id,
      }),
    ).toHaveLength(1);
  });

  it("isolates reads and writes across organizations without leaking resources", () => {
    const fixture = makeRegistry();
    const betaOwner = fixture.service.registerUser({
      email: "beta-owner@example.com",
      display_name: "Beta Owner",
    });
    const beta = fixture.service.createOrganization(betaOwner.id, {
      slug: "beta",
      display_name: "Beta",
    });
    fixture.service.addMember(betaOwner.id, {
      org_id: beta.id,
      user_id: fixture.owner.id,
      role: "viewer",
    });
    fixture.service.createPackage(betaOwner.id, {
      org_id: beta.id,
      name: "beta/core",
      visibility: "private",
    });

    expect(() =>
      fixture.service.listPackages(betaOwner.id, {
        org_id: fixture.organization.id,
      }),
    ).toThrow(RegistryForbiddenError);
    expect(() =>
      fixture.service.getPackage(fixture.owner.id, {
        org_id: beta.id,
        name: "acme/core",
      }),
    ).toThrow(RegistryNotFoundError);
    expect(
      fixture.service
        .listPackages(fixture.owner.id, { org_id: beta.id })
        .map((registryPackage) => registryPackage.name),
    ).toEqual(["beta/core"]);
    expect(() =>
      fixture.service.listAuditEvents(fixture.owner.id, { org_id: beta.id }),
    ).toThrow(RegistryForbiddenError);
    expect(
      fixture.service
        .listAuditEvents(betaOwner.id, { org_id: beta.id })
        .every((event) => event.org_id === beta.id),
    ).toBe(true);
  });

  it("reserves concurrent submissions of the same name@version exactly once", async () => {
    const fixture = makeRegistry();
    const submit = () =>
      Promise.resolve().then(() =>
        fixture.service.submitRelease(fixture.submitter.id, {
          org_id: fixture.organization.id,
          package_name: fixture.registryPackage.name,
          version: "4.0.0",
          artifact: artifact({ fill: 6 }),
        }),
      );

    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(RegistryConflictError),
    });
    expect(
      fixture.service.listReleases(fixture.owner.id, {
        org_id: fixture.organization.id,
        package_name: fixture.registryPackage.name,
      }),
    ).toHaveLength(1);
    expect(
      fixture.service
        .listAuditEvents(fixture.owner.id, { org_id: fixture.organization.id })
        .filter((event) => event.action === "release.submitted"),
    ).toHaveLength(1);
  });

  it("keeps a defensive, append-only, ordered organization audit trail", () => {
    const fixture = makeRegistry();
    publish(fixture, "5.0.0", artifact({ fill: 7 }));
    const events = fixture.service.listAuditEvents(fixture.owner.id, {
      org_id: fixture.organization.id,
    });
    const releaseActions = events
      .filter((event) => event.subject_type === "release")
      .map((event) => event.action);
    expect(releaseActions).toEqual([
      "release.submitted",
      "release.approved",
      "release.approved",
      "release.published",
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((left, right) => left - right),
    );
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);

    const originalFirst = structuredClone(events[0]);
    if (!events[0]) throw new Error("expected audit event");
    events[0].metadata.slug = "tampered";
    events.pop();
    const reloaded = fixture.service.listAuditEvents(fixture.owner.id, {
      org_id: fixture.organization.id,
    });
    expect(reloaded).toHaveLength(events.length + 1);
    expect(reloaded[0]).toEqual(originalFirst);
  });

  it("rejects malformed release lifecycle snapshots at the repository boundary", () => {
    const fixture = makeRegistry();
    const pending = fixture.service.submitRelease(fixture.submitter.id, {
      org_id: fixture.organization.id,
      package_name: fixture.registryPackage.name,
      version: "6.0.0",
      artifact: artifact({ fill: 8 }),
    });
    expect(() =>
      RegistryReleaseSchema.parse({
        ...pending,
        status: "published",
        published_at: new Date().toISOString(),
      }),
    ).toThrow(/exactly two approvals/);
    expect(() =>
      RegistryReleaseSchema.parse({
        ...pending,
        status: "rejected",
        rejected_at: new Date().toISOString(),
        rejection_reason: null,
      }),
    ).toThrow(/timestamp and reason/);
    expect(() => RegistryReleaseSchema.parse({ ...pending, extra: true })).toThrow();
  });

  it("allows publishers to submit but reserves governance actions for owners and admins", () => {
    const fixture = makeRegistry();
    fixture.service.submitRelease(fixture.submitter.id, {
      org_id: fixture.organization.id,
      package_name: fixture.registryPackage.name,
      version: "7.0.0",
      artifact: artifact({ fill: 10 }),
    });
    expect(
      fixture.service.createPackage(fixture.submitter.id, {
        org_id: fixture.organization.id,
        name: "acme/publisher-created",
        visibility: "private",
      }).name,
    ).toBe("acme/publisher-created");
    expect(() =>
      fixture.service.rejectRelease(fixture.submitter.id, {
        ...releaseIdentity(fixture, "7.0.0"),
        reason: "Self rejection is not governance",
      }),
    ).toThrow(RegistryForbiddenError);
  });

  it("supports member role changes and removal without losing the final owner", () => {
    const fixture = makeRegistry();
    expect(() =>
      fixture.service.updateMemberRole(fixture.reviewer.id, {
        org_id: fixture.organization.id,
        user_id: fixture.submitter.id,
        role: "owner",
      }),
    ).toThrow(RegistryForbiddenError);

    expect(
      fixture.service.updateMemberRole(fixture.owner.id, {
        org_id: fixture.organization.id,
        user_id: fixture.reviewer.id,
        role: "owner",
      }).role,
    ).toBe("owner");
    expect(
      fixture.service.removeMember(fixture.reviewer.id, {
        org_id: fixture.organization.id,
        user_id: fixture.owner.id,
        reason: "Ownership transferred to the active maintainer",
      }).role,
    ).toBe("owner");
    expect(() =>
      fixture.service.updateMemberRole(fixture.reviewer.id, {
        org_id: fixture.organization.id,
        user_id: fixture.reviewer.id,
        role: "admin",
      }),
    ).toThrow(/retain at least one owner/);
    expect(() =>
      fixture.service.removeMember(fixture.reviewer.id, {
        org_id: fixture.organization.id,
        user_id: fixture.reviewer.id,
        reason: "Would orphan the organization",
      }),
    ).toThrow(/retain at least one owner/);

    const removedPublisher = fixture.service.removeMember(fixture.reviewer.id, {
      org_id: fixture.organization.id,
      user_id: fixture.submitter.id,
      reason: "Maintainer left the organization",
    });
    expect(removedPublisher.role).toBe("publisher");
    expect(
      fixture.service
        .listAuditEvents(fixture.reviewer.id, {
          org_id: fixture.organization.id,
        })
        .slice(-3)
        .map((event) => event.action),
    ).toEqual([
      "member.role_changed",
      "member.removed",
      "member.removed",
    ]);
  });

  it("projects only the highest published discovery snapshot and falls back after yank", () => {
    const fixture = makeRegistry();
    for (const name of ["acme/discovery", "acme/empty"]) {
      fixture.service.createPackage(fixture.owner.id, {
        org_id: fixture.organization.id,
        name,
        visibility: "public",
      });
    }

    const fallbackDiscovery = discovery({
      description: "Stable Node fallback",
      languages: ["typescript"],
      ecosystems: ["node"],
      tags: ["reliability"],
    });
    const latestDiscovery = discovery({
      description: "Current Rust release",
      languages: ["rust"],
      ecosystems: ["cli"],
      tags: ["security"],
    });
    publishPackage(
      fixture,
      "acme/discovery",
      "2.0.0",
      artifact({ fill: 11 }),
      fallbackDiscovery,
    );
    publishPackage(
      fixture,
      "acme/discovery",
      "10.0.0",
      artifact({ fill: 12 }),
      latestDiscovery,
    );
    fixture.service.submitRelease(
      fixture.submitter.id,
      {
        org_id: fixture.organization.id,
        package_name: "acme/discovery",
        version: "99.0.0",
        artifact: artifact({ fill: 13 }),
      },
      discovery({
        description: "Pending metadata must stay private",
        languages: ["python"],
        ecosystems: ["unpublished"],
        tags: ["pending-only"],
      }),
    );
    publish(
      fixture,
      "9.0.0",
      artifact({ fill: 14 }),
      discovery({
        description: "Private metadata",
        languages: ["secret-language"],
        ecosystems: ["private-only"],
        tags: ["private-only"],
      }),
    );

    const initial = fixture.service.searchPublicPackages({ limit: 100 });
    expect(initial.items).toEqual([
      expect.objectContaining({
        name: "acme/discovery",
        latest_version: "10.0.0",
        discovery_available: true,
        discovery: latestDiscovery,
      }),
      expect.objectContaining({
        name: "acme/empty",
        latest_version: null,
        discovery_available: false,
        discovery: discovery(),
      }),
    ]);
    expect(
      fixture.service.searchPublicPackages({
        tags: ["pending-only"],
        limit: 100,
      }).items,
    ).toEqual([]);
    expect(
      fixture.service.searchPublicPackages({
        tags: ["private-only"],
        limit: 100,
      }).items,
    ).toEqual([]);

    fixture.service.yankRelease(fixture.reviewer.id, {
      org_id: fixture.organization.id,
      package_name: "acme/discovery",
      version: "10.0.0",
      reason: "Latest release requires replacement",
    });
    expect(
      fixture.service.searchPublicPackages({
        tags: ["reliability"],
        limit: 100,
      }).items,
    ).toEqual([
      expect.objectContaining({
        name: "acme/discovery",
        latest_version: "2.0.0",
        discovery_available: true,
        discovery: fallbackDiscovery,
      }),
    ]);
  });

  it("applies facet OR within dimensions, AND across dimensions, and binds cursors", () => {
    const fixture = makeRegistry();
    for (const name of ["acme/discovery-a", "acme/discovery-b", "acme/discovery-c"]) {
      fixture.service.createPackage(fixture.owner.id, {
        org_id: fixture.organization.id,
        name,
        visibility: "public",
      });
    }
    for (const [index, name] of [
      "acme/discovery-a",
      "acme/discovery-b",
    ].entries()) {
      publishPackage(
        fixture,
        name,
        "1.0.0",
        artifact({ fill: 20 + index }),
        discovery({
          languages: ["typescript"],
          ecosystems: ["node"],
          tags: ["security"],
        }),
      );
    }
    publishPackage(
      fixture,
      "acme/discovery-c",
      "1.0.0",
      artifact({ fill: 22 }),
      discovery({
        languages: ["go"],
        ecosystems: ["cloud"],
        tags: ["security"],
      }),
    );

    const first = fixture.service.searchPublicPackages({
      query: "acme/discovery-",
      languages: [" TypeScript ", "GO"],
      ecosystems: ["NODE"],
      tags: ["security", "irrelevant-or-value"],
      limit: 1,
    });
    expect(first.items.map((item) => item.name)).toEqual(["acme/discovery-a"]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = fixture.service.searchPublicPackages({
      query: "acme/discovery-",
      languages: ["go", "typescript"],
      ecosystems: ["node"],
      tags: ["irrelevant-or-value", "SECURITY"],
      cursor: first.next_cursor!,
      limit: 1,
    });
    expect(second.items.map((item) => item.name)).toEqual(["acme/discovery-b"]);
    expect(second.next_cursor).toBeNull();

    expect(() =>
      fixture.service.searchPublicPackages({
        query: "acme/discovery-",
        languages: ["go", "typescript"],
        ecosystems: ["node"],
        tags: ["reliability"],
        cursor: first.next_cursor!,
        limit: 1,
      }),
    ).toThrow(/cursor/i);
  });
});

interface RegistryFixture {
  repository: InMemoryRegistryRepository;
  service: RegistryDomainService;
  owner: RegistryUser;
  reviewer: RegistryUser;
  secondReviewer: RegistryUser;
  submitter: RegistryUser;
  organization: RegistryOrganization;
  registryPackage: ReturnType<RegistryDomainService["createPackage"]>;
}

function makeRegistry(): RegistryFixture {
  const repository = new InMemoryRegistryRepository();
  const service = new RegistryDomainService(repository);
  const owner = service.registerUser({
    email: "owner@example.com",
    display_name: "Owner",
  });
  const reviewer = service.registerUser({
    email: "reviewer@example.com",
    display_name: "Reviewer",
  });
  const secondReviewer = service.registerUser({
    email: "reviewer-two@example.com",
    display_name: "Reviewer Two",
  });
  const submitter = service.registerUser({
    email: "submitter@example.com",
    display_name: "Submitter",
  });
  const organization = service.createOrganization(owner.id, {
    slug: "acme",
    display_name: "Acme",
  });
  service.addMember(owner.id, {
    org_id: organization.id,
    user_id: reviewer.id,
    role: "admin",
  });
  service.addMember(owner.id, {
    org_id: organization.id,
    user_id: secondReviewer.id,
    role: "admin",
  });
  service.addMember(owner.id, {
    org_id: organization.id,
    user_id: submitter.id,
    role: "publisher",
  });
  const registryPackage = service.createPackage(owner.id, {
    org_id: organization.id,
    name: "acme/core",
    visibility: "private",
  });
  return {
    repository,
    service,
    owner,
    reviewer,
    secondReviewer,
    submitter,
    organization,
    registryPackage,
  };
}

function artifact(
  options: {
    fill?: number;
    source_url?: string;
  } = {},
): RegistryArtifact {
  const fill = options.fill ?? 1;
  return {
    integrity: `sha256-${Buffer.alloc(32, fill).toString("base64")}`,
    provenance: {
      source_type: "git",
      source_url: options.source_url ?? "https://example.com/acme/core.git",
      source_commit: (fill % 16).toString(16).repeat(40),
    },
  };
}

function releaseIdentity(fixture: RegistryFixture, version = "1.0.0") {
  return {
    org_id: fixture.organization.id,
    package_name: "acme/core",
    version,
  };
}

function publish(
  fixture: RegistryFixture,
  version: string,
  releaseArtifact: RegistryArtifact,
  releaseDiscovery?: PublicPackDiscoveryDocument,
) {
  return publishPackage(
    fixture,
    "acme/core",
    version,
    releaseArtifact,
    releaseDiscovery,
  );
}

function publishPackage(
  fixture: RegistryFixture,
  packageName: string,
  version: string,
  releaseArtifact: RegistryArtifact,
  releaseDiscovery?: PublicPackDiscoveryDocument,
) {
  fixture.service.submitRelease(
    fixture.submitter.id,
    {
      org_id: fixture.organization.id,
      package_name: packageName,
      version,
      artifact: releaseArtifact,
    },
    releaseDiscovery,
  );
  fixture.service.approveRelease(
    fixture.owner.id,
    {
      org_id: fixture.organization.id,
      package_name: packageName,
      version,
    },
  );
  return fixture.service.approveRelease(
    fixture.reviewer.id,
    {
      org_id: fixture.organization.id,
      package_name: packageName,
      version,
    },
  );
}

function discovery(
  overrides: Partial<PublicPackDiscoveryDocument> = {},
): PublicPackDiscoveryDocument {
  return {
    version: 1,
    description: "",
    languages: [],
    ecosystems: [],
    tags: [],
    lesson_count: 0,
    ...overrides,
  };
}
