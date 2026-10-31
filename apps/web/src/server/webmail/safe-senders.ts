// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHash, randomInt } from "node:crypto";

import { log } from "@anhourmail/server/log";
import { redis } from "@anhourmail/server/redis";
import { matchSafeSender, type SafeSenderMatch, type SenderSets, senderSets } from "@anhourmail/shared/senders";

import { managedSieve } from "../adapters/stalwart";
import { parseScript } from "./sieve";

/**
 * A mailbox's Safe senders for the reader's image check (ADR-0027 §3, docs/internal/05-webmail.md "Remote images"):
 * the `junk.safe` list of its managed Sieve script, read with management credentials (as Settings reads it) and kept
 * parsed in this process's memory only — never in Redis or Postgres, never logged (rule 24).
 *
 * Freshness: Redis holds one counter per mailbox, `webmail:rules:v:<accountId>:<address hash>` (a number, nothing
 * else), bumped by every managed-script write (`rulesWritten`), which also drops the writing process's own entry. A cached list is used while the counter is what it was when the list
 * was read; any other value, or none, reads the script again. While Redis can't be reached a cached list is used for
 * up to `ttlMs` (fail open for availability, never for permission: a stale list only ever decides whether to ask).
 * A read that fails or takes longer than `timeoutMs` answers null: nothing matches, and the reader asks.
 *
 * The list applies to images even while the script is switched off (Settings shows that): it is the person's stated
 * trust, and loading images doesn't depend on the script running. A missing script or one that isn't ours is empty.
 */

/** Cached mailboxes per process (least recently used dropped first). */
export const SAFE_SENDERS_CACHE_MAX = 2_000;
/** How long a cached list is used while Redis can't be reached. */
export const SAFE_SENDERS_TTL_MS = 60_000;
/**
 * The longest a cached list is used even while its counter is unchanged: a write whose bump was lost (Redis down at
 * that moment, back since) is picked up within this time.
 */
export const SAFE_SENDERS_MAX_AGE_MS = 10 * 60_000;
/** The whole lookup's budget on the message-view path. */
export const SAFE_SENDERS_TIMEOUT_MS = 300;
/** The counter key outlives any cached entry; once it expires the next lookup simply reads the script again. */
const VERSION_TTL_SEC = 30 * 24 * 3600;

/**
 * One mailbox: its mail-server account id and its address (hashed, so Redis holds no address). Both, so a principal
 * id the mail server hands out again to another mailbox never inherits a cached list or a counter.
 */
export const mailboxKey = (accountId: string, address: string): string =>
  `${accountId}:${createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 24)}`;

export const rulesVersionKey = (accountId: string, address: string): string =>
  `webmail:rules:v:${mailboxKey(accountId, address)}`;

/** The counter store (Redis in the app). Every call may throw: Redis is down. */
export type RulesVersions = {
  get(key: string): Promise<string | null>;
  /** Creates the counter at `value` (an integer) if it doesn't exist (no change otherwise). */
  init(key: string, value: string): Promise<void>;
  /** Increments it (creating it at a random start first if missing) and answers the new value. */
  bump(key: string): Promise<string>;
};

export type SafeSendersDeps = {
  read: (accountId: string) => Promise<{ content: string; active: boolean } | null>;
  versions: RulesVersions;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  maxAgeMs?: number;
  max?: number;
};

type Entry = {
  /** The counter when the list was read; null: Redis couldn't be reached then (the TTL applies). */
  stamp: string | null;
  at: number;
  sets: SenderSets;
};

class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError("timed out"));
      }, ms);
      timer.unref();
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

export type SafeSenders = {
  /** The mailbox's Safe senders, or null when they can't be read now (nothing matches then). */
  lookup(accountId: string, address: string): Promise<SenderSets | null>;
  /** Which Safe senders entry `from` matches in this mailbox, or null (none, or the list can't be read now). */
  match(accountId: string, address: string, from: string): Promise<SafeSenderMatch | null>;
  /**
   * After a managed-script write: bumps the counter so every process reads the list again, and drops this process's
   * own entry (the next lookup reads what was written; seeding it here could race a concurrent read). Never throws.
   */
  written(accountId: string, address: string): Promise<void>;
};

export function createSafeSenders(deps: SafeSendersDeps): SafeSenders {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SAFE_SENDERS_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? SAFE_SENDERS_TTL_MS;
  const maxAgeMs = deps.maxAgeMs ?? SAFE_SENDERS_MAX_AGE_MS;
  const max = deps.max ?? SAFE_SENDERS_CACHE_MAX;
  const cache = new Map<string, Entry>();

  const remember = (key: string, entry: Entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /**
   * The counter now, or null when Redis can't be reached. A missing counter is created at a random start, never a
   * fixed one: after a Redis flush a process holding a list read before a later write must not see the same value.
   */
  async function stamp(accountId: string, address: string): Promise<string | null> {
    const key = rulesVersionKey(accountId, address);
    try {
      const v = await deps.versions.get(key);
      if (v !== null) return v;
      // Created before the script is read: a write after this point moves it on, so a stale read is never kept.
      await deps.versions.init(key, String(randomInt(1, 2 ** 47)));
      return (await deps.versions.get(key)) ?? null;
    } catch {
      return null;
    }
  }

  async function fresh(accountId: string, address: string): Promise<SenderSets> {
    const key = mailboxKey(accountId, address);
    // The stamp is read before the script: a write in between moves the counter on, so this read is replaced next time.
    const v = await stamp(accountId, address);
    const hit = cache.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < maxAgeMs && (v !== null ? hit.stamp === v : age < ttlMs)) {
      remember(key, hit);
      return hit.sets;
    }
    const script = await deps.read(accountId);
    const safe = script === null ? [] : (parseScript(script.content)?.junk.safe ?? []);
    const sets = senderSets(safe);
    remember(key, { stamp: v, at: now(), sets });
    return sets;
  }

  async function lookup(accountId: string, address: string): Promise<SenderSets | null> {
    try {
      return await within(fresh(accountId, address), timeoutMs);
    } catch (err) {
      // The error's name only: never an entry, an address or the script (rule 24).
      log.warn("safe senders unavailable", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
  }

  return {
    lookup,
    async match(accountId, address, from) {
      const sets = await lookup(accountId, address);
      return sets === null ? null : matchSafeSender(from, sets);
    },
    async written(accountId, address) {
      try {
        await within(deps.versions.bump(rulesVersionKey(accountId, address)), timeoutMs);
      } catch {
        // Redis down: other processes fall back to their TTL.
      }
      cache.delete(mailboxKey(accountId, address));
    },
  };
}

/** The Redis counter store. */
export function redisRulesVersions(): RulesVersions {
  return {
    get: (key) => redis().get(key),
    init: async (key, value) => {
      await redis().set(key, value, "EX", VERSION_TTL_SEC, "NX");
    },
    bump: async (key) => {
      // A missing counter starts at a random number here too (see `stamp`), never at 1.
      const out = await redis()
        .multi()
        .set(key, String(randomInt(1, 2 ** 47)), "EX", VERSION_TTL_SEC, "NX")
        .incr(key)
        .expire(key, VERSION_TTL_SEC)
        .exec();
      const [err, value] = out?.[1] ?? [new Error("no answer"), null];
      if (err || typeof value !== "number") throw err ?? new Error("unexpected answer");
      return String(value);
    },
  };
}

/**
 * This process's Safe senders cache, kept on `globalThis` so Next dev hot reloads don't start a new one. The key names
 * the cache's shape: bump it when `SafeSenders` changes, or a dev server would keep calling the old instance.
 */
const GLOBAL_KEY = "amSafeSendersV2";
const globalForSafe = globalThis as unknown as Record<typeof GLOBAL_KEY, SafeSenders | undefined>;

export function safeSenders(): SafeSenders {
  globalForSafe[GLOBAL_KEY] ??= createSafeSenders({
    read: (accountId) => managedSieve().read(accountId),
    versions: redisRulesVersions(),
  });
  return globalForSafe[GLOBAL_KEY];
}

/** Bumps a mailbox's rules version after a managed-script write outside `saveMailRules` (the start-up upgrade). */
export const bumpRulesVersion = (accountId: string, address: string): Promise<void> =>
  safeSenders().written(accountId, address);
