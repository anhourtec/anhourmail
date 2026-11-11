// SPDX-License-Identifier: MIT
/**
 * A small cross-process queue of account ids in one Redis set: one process adds an id (`signal`), another takes a batch
 * (`take`, `SPOP`, so each id goes to one taker however many there are). Used for work only another process may do
 * (e.g. the worker telling the web app that an account's tier changed). Redis is an optimisation here: both sides
 * swallow store errors (a lost signal is caught by the taker's own start-up pass). Ids only, never anything else.
 */
export type AccountSignals = {
  signal(accountId: string): Promise<void>;
  take(max: number): Promise<string[]>;
};

type SetClient = {
  sadd(key: string, member: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  spop(key: string, count: number): Promise<string[]>;
};

/** Signals left untaken this long (no taker running) are dropped: the taker's start-up pass covers them. */
const TTL_SEC = 7 * 24 * 3600;

export function redisAccountSignals(redis: SetClient, key: string): AccountSignals {
  return {
    signal: async (accountId) => {
      try {
        await redis.sadd(key, accountId);
        await redis.expire(key, TTL_SEC);
      } catch {
        // Fail open: see the module comment.
      }
    },
    take: async (max) => {
      if (max <= 0) return [];
      try {
        return await redis.spop(key, max);
      } catch {
        return [];
      }
    },
  };
}

/** In-process signals for tests. */
export function memoryAccountSignals(): AccountSignals & { pending(): string[] } {
  const ids = new Set<string>();
  return {
    signal: async (accountId) => {
      ids.add(accountId);
    },
    take: async (max) => {
      const out = [...ids].slice(0, Math.max(0, max));
      for (const id of out) ids.delete(id);
      return out;
    },
    pending: () => [...ids],
  };
}

/** The worker → web app signal: an account's trust tier changed, so its managed scripts must follow (ADR-0034). */
export const SENDING_PAUSE_SIGNALS_KEY = "am:webmail:sending-pause:pending";
