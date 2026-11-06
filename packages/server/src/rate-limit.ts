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
  // Sign-up (ADR-0031): issuing a proof-of-work challenge per client address; sign-up attempts with an accepted
  // proof per address (an IPv6 client counts by its /64); then accounts created, per address and per network (IPv4
  // /24, IPv6 /64 per hour and per day, plus IPv6 /56 and /48 per day). The account tiers are taken before the
  // identity layer runs and given back unless it created the account, so failed sign-ups never use them up. The
  // numbers are defaults; the `SIGNUP_LIMIT_*` settings replace them. All fail closed (rule 14).
  signupChallenge: { limit: 30, windowSec: 600, by: "ip", failMode: "closed" },
  signupAttempt: { limit: 20, windowSec: 3600, by: "ip", failMode: "closed" },
  signup: { limit: 5, windowSec: 3600, by: "ip", failMode: "closed" },
  signupDay: { limit: 10, windowSec: 86_400, by: "ip", failMode: "closed" },
  signupNetwork: { limit: 10, windowSec: 3600, by: "ip", failMode: "closed" },
  signupNetworkDay: { limit: 30, windowSec: 86_400, by: "ip", failMode: "closed" },
  signupNetwork56Day: { limit: 60, windowSec: 86_400, by: "ip", failMode: "closed" },
  signupNetwork48Day: { limit: 120, windowSec: 86_400, by: "ip", failMode: "closed" },
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
  // Billing calls that reach the payment provider (checkout, portal, preview, plan and add-on changes; ADR-0029 §9).
  // Each one is a provider request and checkout is a card-testing surface: fail closed.
  billingProvider: { limit: 30, windowSec: 600, by: "caller", failMode: "closed" },
  // Invite codes (ADR-0029 §8): every code entry is a guess at a 160-bit secret, per signed-in caller on the Billing
  // page and per client address (Billing and sign-up). Fail closed: without the limiter nothing bounds guessing.
  inviteCodeRedeem: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
  inviteCodeRedeemIp: { limit: 10, windowSec: 3600, by: "ip", failMode: "closed" },
  // Webmail (docs/internal/05-webmail.md): sign-in guesses a mailbox password, so it fails closed; the JMAP proxy
  // carries every list, open and flag of an active session.
  webmailSignIn: { limit: 10, windowSec: 300, by: "ip", failMode: "closed" },
  webmailSignInAddress: { limit: 10, windowSec: 900, by: "caller", failMode: "closed" },
  webmail: { limit: 900, windowSec: 60, by: "caller", failMode: "open" },
  // Console → webmail handoff (ADR-0024): minting a code per console session, and starting and redeeming one per
  // client address (each redemption mints and destroys a mail-server credential). Fail closed: it opens a mailbox.
  webmailHandoff: { limit: 10, windowSec: 600, by: "caller", failMode: "closed" },
  webmailHandoffIp: { limit: 30, windowSec: 300, by: "ip", failMode: "closed" },
  webmailDownload: { limit: 120, windowSec: 60, by: "caller", failMode: "open" },
  // The push stream (05-webmail.md "Push"): one long-lived stream per browser and mailbox, opened again after a drop
  // or a leader-tab change. Fail open: over the cap or with Redis down the webmail polls instead.
  webmailPush: { limit: 30, windowSec: 300, by: "caller", failMode: "open" },
  // The image proxy: each request makes an outbound fetch from our servers (a message loads at most 100 images).
  // Fail closed: without the limiter, nothing would bound what a session makes us fetch.
  webmailImage: { limit: 300, windowSec: 60, by: "caller", failMode: "closed" },
  // The contacts list reads every card (up to 5,000 in batches): tighter than the proxy.
  webmailContacts: { limit: 120, windowSec: 60, by: "caller", failMode: "open" },
  webmailUpload: { limit: 60, windowSec: 600, by: "caller", failMode: "closed" },
  // Profile photo uploads (console and webmail): each one is an image decode on our servers. Fail closed: without the
  // limiter nothing would bound how much decoding one caller makes us do.
  avatarUpload: { limit: 20, windowSec: 3600, by: "caller", failMode: "closed" },
  // The settings window reads preferences, identities, quota and the managed Sieve script at once.
  webmailSettings: { limit: 60, windowSec: 60, by: "caller", failMode: "open" },
  // Mailbox passwords: an admin's reset (console) and a person's own change (webmail). Each one hashes with argon2id
  // and ends the mailbox's webmail sessions; fail closed (the change sets a credential).
  mailboxPassword: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
  // Free platform addresses (ADR-0021; sign-up is open, so creation is the abuse surface): the availability check
  // per caller, and creation per account and per client address on top of the route's own tier. All fail closed.
  platformAddressCheck: { limit: 60, windowSec: 600, by: "caller", failMode: "closed" },
  platformAddressCheckIp: { limit: 120, windowSec: 600, by: "ip", failMode: "closed" },
  platformMailboxAccount: { limit: 3, windowSec: 86_400, by: "caller", failMode: "closed" },
  platformMailboxIp: { limit: 5, windowSec: 86_400, by: "ip", failMode: "closed" },
  // Staff suspend / lift (`platform.account.suspend`): each one emails customers and queues mail-server jobs for every
  // mailbox in scope. Fail closed (it changes who can sign in).
  staffSuspend: { limit: 30, windowSec: 3600, by: "caller", failMode: "closed" },
  // "Send the confirmation link again": each call emails the person's sign-in address.
  emailVerification: { limit: 5, windowSec: 3600, by: "caller", failMode: "closed" },
  // Confirmation emails per address, however they're asked for (sign-up, a sign-in with the right password but an
  // unconfirmed address, "send the link again"): someone who signed up with another person's address can't use
  // repeated sign-ins to flood it. Keyed by a hash of the address; fail closed (nothing is sent).
  emailVerificationAddress: { limit: 5, windowSec: 86_400, by: "caller", failMode: "closed" },
  // Each call emails an outside address (forwarding confirmation); a per-mailbox daily cap applies in the service.
  forwardingVerify: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
  // Mailbox delegation (ADR-0026 §9): a batch of grants and revokes on a mailbox's three lists, and "Convert to shared
  // mailbox". Each needs a fresh step-up and changes nothing on the mail server but the conversion's password job, so
  // it fails open like other console writes.
  delegationManage: { limit: 30, windowSec: 600, by: "caller", failMode: "open" },
  // Opening a mailbox shared with the person in the webmail (ADR-0026 §6: a "Shared with you" entry or "Open another
  // mailbox" by address). Each one mints and destroys a mail-server credential, and a typed address is a probe: fail
  // closed, so a Redis outage refuses opens (the person's own mailbox still works).
  webmailDelegatedOpen: { limit: 20, windowSec: 600, by: "caller", failMode: "closed" },
  // The account-wide Safe senders list (ADR-0032 §1): each change rewrites a line in every mailbox's managed script in
  // the background, so tighter than other console writes; no sending effect, so it fails open.
  accountSafeSenders: { limit: 30, windowSec: 600, by: "caller", failMode: "open" },
  // Mail import (ADR-0030 §15): starting or resuming one mints a mail-server credential, so it fails closed; the
  // handler also counts starts per account and day (`importStartAccount`, only for callers who may import there). The
  // admins' CSV batch mints one per row.
  importStart: { limit: 10, windowSec: 3600, by: "caller", failMode: "closed" },
  importStartAccount: { limit: 30, windowSec: 86_400, by: "caller", failMode: "closed" },
  importBatch: { limit: 3, windowSec: 3600, by: "caller", failMode: "closed" },
} as const satisfies Record<string, RateLimit>;

export type LimitName = keyof typeof LIMITS;

/** Increments `key` in a window of `windowSec` and returns the new count. */
export type Counter = (key: string, windowSec: number) => Promise<number>;

export type RateLimitResult = {
  allowed: boolean;
  headers: Record<string, string>;
  degraded: boolean;
  /** The key that was counted (absent when the store failed): `Uncount` gives the request back. */
  key?: string;
};

/** Gives one counted request back (Redis `DECR`), e.g. a sign-up that didn't create an account. */
export type Uncount = (key: string) => Promise<void>;

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
    return { allowed: count <= max, headers, degraded: false, key };
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

/** Only while the window's key still exists, so a give-back after the window ended leaves no stray key behind. */
const UNCOUNT_SCRIPT = "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end return 0";

export function redisUncount(redis: {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}): Uncount {
  return async (key) => {
    await redis.eval(UNCOUNT_SCRIPT, 1, key);
  };
}

/** In-process counter for tests; `uncount` gives a counted request back. */
export function memoryCounter(): Counter & { uncount: Uncount } {
  const counts = new Map<string, number>();
  const counter = async (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  return Object.assign(counter, {
    uncount: async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) - 1);
    },
  });
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
