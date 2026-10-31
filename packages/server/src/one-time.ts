// SPDX-License-Identifier: MIT
/**
 * One-time claims (e.g. an authenticator code may be accepted once): `SET key 1 NX PX ttl` in one round trip, so of
 * any number of concurrent callers exactly one gets `true`. Errors propagate: callers refuse on a store failure.
 */
export type OneTimeStore = (key: string, ttlMs: number) => Promise<boolean>;

export function redisOneTime(redis: {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null>;
}): OneTimeStore {
  return async (key, ttlMs) => (await redis.set(key, "1", "PX", ttlMs, "NX")) === "OK";
}

/** In-process store for tests (single-threaded, so check-and-set is atomic). */
export function memoryOneTime(now: () => number = Date.now): OneTimeStore {
  const until = new Map<string, number>();
  return async (key, ttlMs) => {
    const t = now();
    if ((until.get(key) ?? 0) > t) return false;
    until.set(key, t + ttlMs);
    return true;
  };
}

/**
 * Atomic strike counters (e.g. wrong passwords in one console session): increments `key` and returns the new count, the
 * window starting at the first strike (`ttlMs`). One Lua call, so concurrent strikes never lose a count. Errors
 * propagate: callers fail closed.
 */
export type StrikeCounter = (key: string, ttlMs: number) => Promise<number>;

const STRIKE_SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n";

export function redisStrikes(redis: {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}): StrikeCounter {
  return async (key, ttlMs) => Number(await redis.eval(STRIKE_SCRIPT, 1, key, ttlMs));
}

/** In-process counter for tests (single-threaded, so each increment is atomic). */
export function memoryStrikes(now: () => number = Date.now): StrikeCounter {
  const counts = new Map<string, { n: number; until: number }>();
  return async (key, ttlMs) => {
    const t = now();
    const c = counts.get(key);
    const next = c && c.until > t ? { n: c.n + 1, until: c.until } : { n: 1, until: t + ttlMs };
    counts.set(key, next);
    return next.n;
  };
}
