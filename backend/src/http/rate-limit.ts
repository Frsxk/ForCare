import { createHash } from "node:crypto";

type Bucket = { count: number; resetAt: number };

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type FixedWindowOptions = {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
};

const CLEANUP_BUDGET = 64;

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: FixedWindowOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (existing && now < existing.resetAt) {
      if (existing.count >= this.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true };
    }

    if (existing) this.buckets.delete(key);
    this.pruneExpired(now, CLEANUP_BUDGET);
    if (this.buckets.size >= this.maxKeys) {
      // At capacity, reclaim every expired bucket before failing closed. Never
      // evict a live bucket: that would reset an attacker-targeted limit.
      this.pruneExpired(now, this.maxKeys);
      if (this.buckets.size >= this.maxKeys) {
        return { allowed: false, retryAfterSeconds: this.secondsUntilCapacityFrees(now) };
      }
    }
    this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    return { allowed: true };
  }

  private pruneExpired(now: number, budget: number): void {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      // One limiter has one fixed window, so insertion order is expiry order.
      if (now < bucket.resetAt) break;
      this.buckets.delete(key);
      removed += 1;
      if (removed >= budget) break;
    }
  }

  private secondsUntilCapacityFrees(now: number): number {
    let earliest = Infinity;
    for (const bucket of this.buckets.values()) {
      if (bucket.resetAt < earliest) earliest = bucket.resetAt;
    }
    if (!Number.isFinite(earliest)) return 1;
    return Math.max(1, Math.ceil((earliest - now) / 1000));
  }
}

export type RateLimiters = {
  login: FixedWindowRateLimiter;
  // Login is limited twice, additively: 5 attempts per (IP, email) and 30 per IP
  // per 15 minutes. The per-IP cap bounds Argon2 work even when the email varies.
  loginIp: FixedWindowRateLimiter;
  registration: FixedWindowRateLimiter;
  authenticated: FixedWindowRateLimiter;
};

export function createRateLimiters(overrides: Partial<RateLimiters> = {}): RateLimiters {
  return {
    login:
      overrides.login ??
      new FixedWindowRateLimiter({ limit: 5, windowMs: 15 * 60_000, maxKeys: 5_000 }),
    loginIp:
      overrides.loginIp ??
      new FixedWindowRateLimiter({ limit: 30, windowMs: 15 * 60_000, maxKeys: 10_000 }),
    registration:
      overrides.registration ??
      new FixedWindowRateLimiter({ limit: 3, windowMs: 60 * 60_000, maxKeys: 5_000 }),
    authenticated:
      overrides.authenticated ??
      new FixedWindowRateLimiter({ limit: 120, windowMs: 60_000, maxKeys: 20_000 }),
  };
}

export function loginRateKey(ip: string | null, normalizedEmail: string): string {
  return `${ip ?? "unknown"}|${createHash("sha256").update(normalizedEmail).digest("hex")}`;
}
