import { describe, expect, it } from "vitest";
import { createHumanActor } from "../src/registry-auth.js";
import { createRegistryServer } from "../src/registry-server.js";
import { EntitlementService } from "../src/registry-telemetry.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const SUBJECT_ID = "20000000-0000-4000-8000-000000000001";
const NOW = "2026-07-16T12:00:00.000Z";

describe("Registry entitlement HTTP reads", () => {
  it("reports release approvals for a free organization", async () => {
    const actor = createHumanActor(
      {
        provider: "test",
        issuer: "https://identity.example.com/",
        providerSubjectId: SUBJECT_ID,
        subjectId: SUBJECT_ID,
        tenantId: ORG_ID,
        verifiedAt: NOW,
      },
      "owner",
    );
    const app = createRegistryServer({
      actorResolver: () => actor,
      entitlements: new EntitlementService("enforced"),
      clock: () => new Date(NOW),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/orgs/${ORG_ID}/entitlements`,
        headers: { authorization: "Bearer test-token" },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data).toMatchObject({
        billing_mode: "enforced",
        plan: "free",
        entitlements: {
          privatePacks: false,
          releaseApprovals: true,
        },
      });
    } finally {
      await app.close();
    }
  });
});
