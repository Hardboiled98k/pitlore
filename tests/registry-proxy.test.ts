import { describe, expect, it } from "vitest";
import { normalizeRegistryTrustProxy } from "../src/registry-server.js";
import { loadRegistryTrustProxyEnvironment } from "../src/registry-runtime.js";

describe("Registry reverse-proxy trust boundary", () => {
  it("keeps forwarding headers disabled by default and parses an explicit allow-list", () => {
    expect(loadRegistryTrustProxyEnvironment({})).toBeUndefined();
    expect(
      loadRegistryTrustProxyEnvironment({ PITLORE_TRUST_PROXY: "  " }),
    ).toBeUndefined();
    expect(
      loadRegistryTrustProxyEnvironment({
        PITLORE_TRUST_PROXY: "127.0.0.1, 10.20.0.0/16, ::1/128",
      }),
    ).toEqual(["127.0.0.1", "10.20.0.0/16", "::1/128"]);
    expect(normalizeRegistryTrustProxy(["127.0.0.1", "127.0.0.1"])).toEqual([
      "127.0.0.1",
    ]);
  });

  it.each([
    "true",
    "*",
    "proxy.internal",
    "0.0.0.0/0",
    "::/0",
    "127.0.0.1/33",
    "::1/129",
    "127.0.0.1,",
  ])("rejects unsafe or ambiguous trust entry %s", (configured) => {
    expect(() =>
      loadRegistryTrustProxyEnvironment({ PITLORE_TRUST_PROXY: configured }),
    ).toThrow(/trusted proxy/i);
  });
});
