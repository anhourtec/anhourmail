// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { db, pgMailboxStatusLookup } from "@anhourmail/adapters/postgres";
import { MailboxAccessGate } from "@anhourmail/core/webmail";
import { keyRingFromEnv } from "@anhourmail/server/keyring";
import { type FailureStore, redisFailureStore, redisSlidingQuota } from "@anhourmail/server/rate-limit";
import { redis } from "@anhourmail/server/redis";

import { stalwartOAuthPort } from "../adapters/stalwart-oauth";
import { env } from "../env";
import { type SessionKv, WebmailSessionStore } from "./session-store";
import { WebmailService } from "./service";

/**
 * The webmail session cookie (ADR-0003): opaque id only, HttpOnly, SameSite=Lax, host-only. On https it is
 * `__Host-` prefixed and Secure; in dev (http, ports share one cookie jar) it still has its own name, distinct from
 * the console's `am.session_token`.
 */
export function webmailCookieName(): string {
  return env().WEBMAIL_URL.startsWith("https://") ? "__Host-am.webmail" : "am.webmail";
}

export function webmailCookie(value: string, maxAgeSec: number): string {
  const secure = env().WEBMAIL_URL.startsWith("https://");
  return [
    `${webmailCookieName()}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(maxAgeSec)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The webmail session id from a Cookie header (route handlers). */
export function webmailSessionId(cookieHeader: string | null): string | null {
  const name = webmailCookieName().replace(/[.]/g, "\\.");
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader ?? "");
  return m?.[1] ?? null;
}

/** Compare-and-set for session records (see `SessionKv.cas`): atomic in Redis. */
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local v = string.match(cur, '^(%d+)%.') or '0'
if v ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

const redisKv = (): SessionKv => ({
  get: (k) => redis().get(k),
  set: async (k, v, ttl, mode) => {
    if (mode === "update") return (await redis().set(k, v, "EX", ttl, "XX")) !== null;
    await redis().set(k, v, "EX", ttl);
    return true;
  },
  cas: async (k, expected, v, ttl) => Number(await redis().eval(CAS_SCRIPT, 1, k, expected, v, ttl)) === 1,
  del: async (k) => {
    await redis().del(k);
  },
});

let failureStore: FailureStore | null = null;

/** Wrong-password counts per address (failure-only limit; Redis). */
export function webmailFailures(): FailureStore {
  failureStore ??= redisFailureStore(redis());
  return failureStore;
}

let instance: WebmailService | null = null;

/** The webmail BFF service (lazy, one per server process; rebuilt when this module reloads in dev). */
export function webmail(): WebmailService {
  if (!instance) {
    const e = env();
    const stalwartUrl = e.STALWART_URL;
    if (!stalwartUrl) throw new Error("STALWART_URL is not set");
    const ring = keyRingFromEnv({
      spec: e.SECRETS_KEYRING,
      production: e.NODE_ENV === "production",
      devFallbackSecret: e.BETTER_AUTH_SECRET,
    });
    instance = new WebmailService({
      store: new WebmailSessionStore(redisKv(), ring),
      oauth: stalwartOAuthPort({ stalwartUrl, webmailUrl: e.WEBMAIL_URL }),
      stalwartUrl,
      access: new MailboxAccessGate(pgMailboxStatusLookup(db())),
      quota: redisSlidingQuota(redis()),
    });
  }
  return instance;
}
