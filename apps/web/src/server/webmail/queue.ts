// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user request queue for the JMAP proxy (docs/internal/05-webmail.md "Concurrency", ADR-0018): Stalwart allows
 * 4 concurrent requests per user and answers the rest with `urn:ietf:params:jmap:error:limit`, so the BFF keeps at
 * most `maxInFlight` upstream requests per user and queues the rest (FIFO). A bounded backlog stops one runaway tab
 * from holding unbounded memory. Per process: with several app instances the retry on `limit` covers the overlap.
 */
import { addTiming } from "../http/server-timing";

export class QueueFullError extends Error {
  override readonly name = "QueueFullError";
}

type Lane = { active: number; waiting: (() => void)[] };

export class UserQueue {
  readonly #lanes = new Map<string, Lane>();

  constructor(
    readonly maxInFlight = 4,
    readonly maxWaiting = 64,
  ) {}

  /** Runs `task` for `key` once a slot is free. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { active: 0, waiting: [] };
      this.#lanes.set(key, lane);
    }
    if (lane.active >= this.maxInFlight) {
      if (lane.waiting.length >= this.maxWaiting) throw new QueueFullError("Too many queued requests");
      const l = lane;
      const asked = performance.now();
      await new Promise<void>((resolve) => l.waiting.push(resolve));
      addTiming("queue", performance.now() - asked);
    }
    lane.active += 1;
    try {
      return await task();
    } finally {
      lane.active -= 1;
      const next = lane.waiting.shift();
      if (next) next();
      else if (lane.active === 0) this.#lanes.delete(key);
    }
  }

  /** Requests running and waiting for `key` (tests and diagnostics). */
  stats(key: string): { active: number; waiting: number } {
    const lane = this.#lanes.get(key);
    return { active: lane?.active ?? 0, waiting: lane?.waiting.length ?? 0 };
  }
}

/**
 * Retries `attempt` while it reports a JMAP `limit` error, with jittered exponential backoff. `attempt` returns
 * `{ retry: true }` for a limit error, or the final value.
 */
export async function withLimitRetry<T>(
  attempt: () => Promise<{ retry: true } | { retry: false; value: T }>,
  opts: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<T | null> {
  const tries = opts.tries ?? 4;
  const base = opts.baseMs ?? 80;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let i = 0; i < tries; i++) {
    const r = await attempt();
    if (!r.retry) return r.value;
    if (i < tries - 1) await sleep(base * 2 ** i * (0.5 + random()));
  }
  return null;
}
