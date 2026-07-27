import { describe, expect, it } from "vitest";
import { PublicRateLimiter } from "../src/registry-rate-limit.js";

function makeLimiter(
  capacity: number,
  refillPerSecond: number,
  maxClients: number,
) {
  let nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const limiter = new PublicRateLimiter({
    capacity,
    refillPerSecond,
    maxClients,
    clock: () => new Date(nowMs),
  });
  return {
    limiter,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("Public Registry rate limiter", () => {
  it("rejects invalid construction options", () => {
    const clock = () => new Date(0);
    expect(
      () =>
        new PublicRateLimiter({
          capacity: 0,
          refillPerSecond: 1,
          maxClients: 1,
          clock,
        }),
    ).toThrow("capacity must be a positive integer");
    expect(
      () =>
        new PublicRateLimiter({
          capacity: 1,
          refillPerSecond: 0,
          maxClients: 1,
          clock,
        }),
    ).toThrow("refillPerSecond must be a positive number");
    expect(
      () =>
        new PublicRateLimiter({
          capacity: 1,
          refillPerSecond: 1,
          maxClients: 0.5,
          clock,
        }),
    ).toThrow("maxClients must be a positive integer");
  });

  it("allows a burst up to capacity and then denies with a whole-second retry hint", () => {
    const { limiter } = makeLimiter(2, 0.5, 10);
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-a").allowed).toBe(true);
    const denied = limiter.check("client-a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(2);
  });

  it("refills continuously and caps stored tokens at capacity", () => {
    const { limiter, advance } = makeLimiter(2, 0.5, 10);
    limiter.check("client-a");
    limiter.check("client-a");
    advance(1_000);
    const stillDenied = limiter.check("client-a");
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.retryAfterSeconds).toBe(1);
    advance(1_000);
    expect(limiter.check("client-a").allowed).toBe(true);
    advance(3_600_000);
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-a").allowed).toBe(false);
  });

  it("tracks distinct clients independently", () => {
    const { limiter } = makeLimiter(1, 1, 10);
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-a").allowed).toBe(false);
    expect(limiter.check("client-b").allowed).toBe(true);
  });

  it("bounds tracked clients by evicting the least recently seen key", () => {
    const { limiter, advance } = makeLimiter(1, 0.001, 2);
    expect(limiter.check("client-a").allowed).toBe(true);
    advance(10);
    expect(limiter.check("client-b").allowed).toBe(true);
    advance(10);
    expect(limiter.check("client-c").allowed).toBe(true);
    expect(limiter.trackedClients).toBe(2);
    // client-a was evicted while exhausted; its bucket resets on return, which
    // is the accepted trade-off for bounded memory in a depth-defence limiter.
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.trackedClients).toBe(2);
  });

  it("never evicts the only remaining tracked key", () => {
    const { limiter } = makeLimiter(1, 1, 1);
    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-b").allowed).toBe(true);
    expect(limiter.trackedClients).toBe(1);
  });
});
