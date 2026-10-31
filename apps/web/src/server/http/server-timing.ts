// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where a webmail API request spends its time on the server, as a `Server-Timing` response header and one debug log
 * line (`route()`; docs/internal/05-webmail.md "Performance"). Only fixed phase names, durations and counts ever go
 * in: never ids, addresses, tokens or mail content (CLAUDE.md rules 12, 24). Phases may overlap (a gate's time
 * includes the session reads it makes); `total` is the whole request.
 */

/** The phases measured. A fixed list, so nothing a request carries can become a header value. */
export const PHASES = [
  /** Rate-limit check (Redis). */
  "rate",
  /** The control-plane access check (suspended, deleting, gone; console-session end). */
  "access",
  /** The delegation gate (a mailbox shared with the person). */
  "delegation",
  /** The first-sign-in password-change gate. */
  "password",
  /** Session record reads and writes (Redis, decrypt). */
  "kv",
  /** Session reads answered from this request's own copy. */
  "kvhit",
  /** Control-plane lookups (Postgres) made by the gates and the BFF. */
  "db",
  /** Mail-server token refresh. */
  "refresh",
  /** Waiting for a slot in the person's mail-server queue (≤ 4 in flight). */
  "queue",
  /** Mail-server HTTP calls (JMAP, session, downloads). */
  "stalwart",
  /** The route handler itself (everything after the gates). */
  "handler",
] as const;
export type Phase = (typeof PHASES)[number];

type Entry = { dur: number; count: number };
export type Timings = Map<Phase, Entry>;

const store = new AsyncLocalStorage<Timings>();

/** Runs `fn` with a fresh set of timings (one per request). */
export function withTimings<T>(fn: (t: Timings) => T): T {
  const t: Timings = new Map();
  return store.run(t, () => fn(t));
}

/** The running request's timings, or undefined outside one. */
export const currentTimings = (): Timings | undefined => store.getStore();

/** Adds `ms` (and one occurrence) to `phase` of the running request; nothing outside a request. */
export function addTiming(phase: Phase, ms: number): void {
  const t = store.getStore();
  if (!t) return;
  const e = t.get(phase);
  if (e) {
    e.dur += ms;
    e.count += 1;
  } else t.set(phase, { dur: ms, count: 1 });
}

/** Times `fn` as one occurrence of `phase` (also when it throws). */
export async function timed<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  if (!store.getStore()) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    addTiming(phase, performance.now() - started);
  }
}

const ms = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The `Server-Timing` value: `total;dur=…` then each phase measured, in `PHASES` order, with `desc` the number of
 * occurrences when more than one (`kv;dur=1.4;desc="x3"`).
 */
export function serverTimingHeader(t: Timings, totalMs: number): string {
  const parts = [`total;dur=${ms(totalMs)}`];
  for (const phase of PHASES) {
    const e = t.get(phase);
    if (!e) continue;
    parts.push(`${phase};dur=${ms(e.dur)}${e.count > 1 ? `;desc="x${String(e.count)}"` : ""}`);
  }
  return parts.join(", ");
}

/** The same as a flat log object (`{ totalMs, kvMs, kvCount, … }`) for the debug line. */
export function timingFields(t: Timings, totalMs: number): Record<string, number> {
  const out: Record<string, number> = { totalMs: Math.round(totalMs) };
  for (const phase of PHASES) {
    const e = t.get(phase);
    if (!e) continue;
    out[`${phase}Ms`] = Math.round(e.dur * 10) / 10;
    out[`${phase}Count`] = e.count;
  }
  return out;
}
