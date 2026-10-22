// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import { log } from "./log";

/**
 * Fixed-window rate limits (CLAUDE.md rule 14; table in docs/internal/rate-limits.md).
 * Fail mode is per tier: `open` lets requests through when Redis is down (ordinary reads/writes); `closed`
 * refuses them (anything that costs money or reputation: sign-in, sign-up, invites, sending, exports).
 */
export type RateLimit = {
  limit: number;
  windowSec: number;
  by: "caller" | "ip";
  failMode: "open" | "closed";
};

export const LIMITS = {
  read: { limit: 600, windowSec: 60, by: "caller", failMode: "open" },
  write: { limit: 120, windowSec: 60, by: "caller", failMode: "open" },
  auth: { limit: 30, windowSec: 60, by: "ip", failMode: "closed" },
  publicForm: { limit: 10, windowSec: 900, by: "ip", failMode: "closed" },
  invite: { limit: 20, windowSec: 900, by: "ip", failMode: "closed" },
  dnsVerify: { limit: 30, windowSec: 3600, by: "caller", failMode: "open" },
  aliasCreate: { limit: 60, windowSec: 3600, by: "caller", failMode: "closed" },
  export: { limit: 5, windowSec: 3600, by: "caller", failMode: "closed" },
  sending: { limit: 60, windowSec: 3600, by: "caller", failMode: "closed" },
  webhook: { limit: 120, windowSec: 60, by: "ip", failMode: "open" },
} as const satisfies Record<string, RateLimit>;

export type LimitName = keyof typeof LIMITS;

/** Increments `key` in a window of `windowSec` and returns the new count. */
export type Counter = (key: string, windowSec: number) => Promise<number>;

export type RateLimitResult = { allowed: boolean; headers: Record<string, string>; degraded: boolean };

/** Dev/test only: multiplies every limit (RATE_LIMIT_MULTIPLIER), so harness runs don't trip production limits. */
const multiplier = () => {
  const m = Number(process.env.RATE_LIMIT_MULTIPLIER ?? "1");
  return process.env.NODE_ENV !== "production" && Number.isFinite(m) && m >= 1 ? m : 1;
};

/** Stable caller id: a hash of the session cookie when signed in, else the client IP. Never the raw cookie. */
export function callerKey(sessionToken: string | null, ip: string | null): string {
  if (sessionToken) return `s:${createHash("sha256").update(sessionToken).digest("base64url").slice(0, 22)}`;
  return `ip:${ip ?? "direct"}`;
}

export async function checkRateLimit(
  counter: Counter,
  name: string,
  limit: RateLimit,
  caller: string,
  now = Date.now(),
): Promise<RateLimitResult> {
  const max = limit.limit * multiplier();
  const window = Math.floor(now / 1000 / limit.windowSec);
  const reset = (window + 1) * limit.windowSec - Math.floor(now / 1000);
  const key = `am:rl:${name}:${caller}:${limit.windowSec}:${window}`;
  try {
    const count = await counter(key, limit.windowSec);
    const remaining = Math.max(0, max - count);
    const headers: Record<string, string> = {
      "RateLimit-Limit": String(max),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(reset),
    };
    if (count > max) headers["Retry-After"] = String(reset);
    return { allowed: count <= max, headers, degraded: false };
  } catch (err) {
    log.warn("rate limiter unavailable", { component: "rate-limit", limit: name, failMode: limit.failMode, err });
    return { allowed: limit.failMode === "open", headers: {}, degraded: true };
  }
}

/** Redis-backed counter: INCR, and EXPIRE on the first hit of a window. */
export function redisCounter(redis: {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}): Counter {
  return async (key, windowSec) => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec + 1);
    return n;
  };
}

/** In-process counter for tests. */
export function memoryCounter(): Counter {
  const counts = new Map<string, number>();
  return async (key) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
}
