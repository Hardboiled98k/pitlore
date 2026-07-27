/**
 * Application-level token-bucket limiter for the unauthenticated public
 * Registry surface. This is defence in depth for self-hosted deployments; it
 * does not replace an edge gateway, TLS proxy rate limiting, or operational
 * abuse response, and public deployments must still provide those.
 */

export interface PublicRateLimiterOptions {
  /** Maximum burst of requests a single client key may spend at once. */
  readonly capacity: number;
  /** Sustained refill rate in tokens per second per client key. */
  readonly refillPerSecond: number;
  /** Upper bound on tracked client keys; oldest-seen keys are evicted first. */
  readonly maxClients: number;
  readonly clock?: () => Date;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds a denied client should wait; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

export class PublicRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxClients: number;
  private readonly clock: () => Date;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: PublicRateLimiterOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Rate limiter capacity must be a positive integer");
    }
    if (
      !Number.isFinite(options.refillPerSecond) ||
      options.refillPerSecond <= 0
    ) {
      throw new Error("Rate limiter refillPerSecond must be a positive number");
    }
    if (!Number.isSafeInteger(options.maxClients) || options.maxClients < 1) {
      throw new Error("Rate limiter maxClients must be a positive integer");
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxClients = options.maxClients;
    this.clock = options.clock ?? (() => new Date());
  }

  check(key: string): RateDecision {
    const nowMs = this.clock().getTime();
    const existing = this.buckets.get(key);
    let tokens = this.capacity;
    if (existing) {
      const elapsedMs = Math.max(0, nowMs - existing.updatedAtMs);
      tokens = Math.min(
        this.capacity,
        existing.tokens + (elapsedMs / 1000) * this.refillPerSecond,
      );
      // Delete before re-insert so Map iteration order stays least-recently
      // seen first, which is what eviction below relies on.
      this.buckets.delete(key);
    }
    let decision: RateDecision;
    if (tokens >= 1) {
      tokens -= 1;
      decision = { allowed: true, retryAfterSeconds: 0 };
    } else {
      decision = {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((1 - tokens) / this.refillPerSecond),
        ),
      };
    }
    this.buckets.set(key, { tokens, updatedAtMs: nowMs });
    while (this.buckets.size > this.maxClients) {
      const oldest = this.buckets.keys().next();
      if (oldest.done || oldest.value === key) break;
      this.buckets.delete(oldest.value);
    }
    return decision;
  }

  /** Number of client keys currently tracked; exposed for regression tests. */
  get trackedClients(): number {
    return this.buckets.size;
  }
}
