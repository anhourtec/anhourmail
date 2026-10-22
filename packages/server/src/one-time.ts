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
