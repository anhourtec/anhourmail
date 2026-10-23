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
  // Second sign-in steps (authenticator code, recovery code, passkey): tighter than `auth`, on top of the identity
  // layer's per-challenge and per-account lockout.
  authFactor: { limit: 10, windowSec: 300, by: "ip", failMode: "closed" },
  publicForm: { limit: 10, windowSec: 900, by: "ip", failMode: "closed" },
  // Per signed-in caller: each invite or resend sends an email (plus a per-account daily cap in the service).
  invite: { limit: 20, windowSec: 900, by: "caller", failMode: "closed" },
  // Role changes and removals of people (per caller, fail closed).
  sensitive: { limit: 30, windowSec: 3600, by: "caller", failMode: "closed" },
  dnsVerify: { limit: 30, windowSec: 3600, by: "caller", failMode: "open" },
  // Console global search (app bar): each call reads several lists, so tighter than `read`.
  search: { limit: 60, windowSec: 60, by: "caller", failMode: "open" },
  aliasCreate: { limit: 60, windowSec: 3600, by: "caller", failMode: "closed" },
  export: { limit: 5, windowSec: 3600, by: "caller", failMode: "closed" },
  sending: { limit: 60, windowSec: 3600, by: "caller", failMode: "closed" },
  webhook: { limit: 120, windowSec: 60, by: "ip", failMode: "open" },
  // Webmail (docs/internal/05-webmail.md): sign-in guesses a mailbox password, so it fails closed; the JMAP proxy
  // carries every list, open and flag of an active session.
  webmailSignIn: { limit: 10, windowSec: 300, by: "ip", failMode: "closed" },
  webmailSignInAddress: { limit: 10, windowSec: 900, by: "caller", failMode: "closed" },
  webmail: { limit: 900, windowSec: 60, by: "caller", failMode: "open" },
  webmailDownload: { limit: 120, windowSec: 60, by: "caller", failMode: "open" },
  // The contacts list reads every card (up to 5,000 in batches): tighter than the proxy.
  webmailContacts: { limit: 120, windowSec: 60, by: "caller", failMode: "open" },
  webmailUpload: { limit: 60, windowSec: 600, by: "caller", failMode: "closed" },
  // The settings window reads preferences, identities, quota and the managed Sieve script at once.
  webmailSettings: { limit: 60, windowSec: 60, by: "caller", failMode: "open" },
  // Mailbox passwords: an admin's reset (console) and a person's own change (webmail). Each one hashes with argon2id
  // and ends the mailbox's webmail sessions; fail closed (the change sets a credential).
  mailboxPassword: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
  // Each call emails an outside address (forwarding confirmation); a per-mailbox daily cap applies in the service.
  forwardingVerify: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
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

/**
 * Failure-only limits (e.g. wrong passwords per address): `failuresExceeded` reads without counting, and
 * `recordFailure` counts only when an attempt failed, so a person signing in successfully never locks themselves
 * out and an attacker can't lock a victim out with correct-looking traffic. Same fixed windows and fail modes as
 * `checkRateLimit`.
 */
export type FailureStore = {
  get(key: string): Promise<number>;
  incr(key: string, windowSec: number): Promise<number>;
};

const failureKey = (name: string, limit: RateLimit, subject: string, now: number) =>
  `am:rl:${name}:${subject}:${String(limit.windowSec)}:${String(Math.floor(now / 1000 / limit.windowSec))}`;

export async function failuresExceeded(
  store: FailureStore,
  name: string,
  limit: RateLimit,
  subject: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    return (await store.get(failureKey(name, limit, subject, now))) >= limit.limit * multiplier();
  } catch (err) {
    log.warn("failure limiter unavailable", { component: "rate-limit", limit: name, failMode: limit.failMode, err });
    return limit.failMode === "closed";
  }
}

export async function recordFailure(
  store: FailureStore,
  name: string,
  limit: RateLimit,
  subject: string,
  now = Date.now(),
): Promise<void> {
  try {
    await store.incr(failureKey(name, limit, subject, now), limit.windowSec);
  } catch (err) {
    log.warn("failure limiter unavailable", { component: "rate-limit", limit: name, err });
  }
}

export function redisFailureStore(redis: {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}): FailureStore {
  return {
    get: async (key) => Number((await redis.get(key)) ?? "0"),
    incr: async (key, windowSec) => {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowSec + 1);
      return n;
    },
  };
}

/** In-process failure store for tests. */
export function memoryFailureStore(): FailureStore {
  const counts = new Map<string, number>();
  return {
    get: async (key) => counts.get(key) ?? 0,
    incr: async (key) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
  };
}

/**
 * Sliding-window quotas for sending (rate-limits.md "sending"; CLAUDE.md rule 27): several windows (e.g. per hour
 * and per day, per mailbox and per session) are checked and charged together, atomically, by `units` (recipients).
 * Either every window has room and all are charged, or nothing is charged. Callers treat a store error as "refuse"
 * (fail closed).
 */
export type QuotaWindow = { key: string; limit: number; windowSec: number };

export type SlidingQuotaStore = {
  /** Charges `units` to every window if all have room; returns false (charging nothing) otherwise. */
  take(windows: QuotaWindow[], units: number, now: number, id: string): Promise<boolean>;
};

/** Lua: drop expired entries, check every window, then add `units` members to each. Atomic in Redis. */
const TAKE_SCRIPT = `
local now = tonumber(ARGV[1])
local units = tonumber(ARGV[2])
local id = ARGV[3]
for i = 1, #KEYS do
  local win = tonumber(ARGV[2 + 2 * i]) * 1000
  local lim = tonumber(ARGV[3 + 2 * i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - win)
  if redis.call('ZCARD', KEYS[i]) + units > lim then return 0 end
end
for i = 1, #KEYS do
  local win = tonumber(ARGV[2 + 2 * i]) * 1000
  for u = 1, units do redis.call('ZADD', KEYS[i], now, id .. ':' .. u) end
  redis.call('PEXPIRE', KEYS[i], win + 1000)
end
return 1
`;

export function redisSlidingQuota(redis: {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}): SlidingQuotaStore {
  return {
    take: async (windows, units, now, id) => {
      const args: (string | number)[] = [now, units, id];
      for (const w of windows) args.push(w.windowSec, w.limit * multiplier());
      const res = await redis.eval(TAKE_SCRIPT, windows.length, ...windows.map((w) => w.key), ...args);
      return Number(res) === 1;
    },
  };
}

/** In-process sliding quotas for tests (same semantics as the Redis script). */
export function memorySlidingQuota(): SlidingQuotaStore {
  const entries = new Map<string, number[]>();
  return {
    take: async (windows, units, now) => {
      for (const w of windows) {
        const live = (entries.get(w.key) ?? []).filter((t) => t > now - w.windowSec * 1000);
        entries.set(w.key, live);
        if (live.length + units > w.limit * multiplier()) return false;
      }
      for (const w of windows)
        entries.set(w.key, [...(entries.get(w.key) ?? []), ...Array.from({ length: units }, () => now)]);
      return true;
    },
  };
}
