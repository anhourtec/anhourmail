// SPDX-License-Identifier: AGPL-3.0-only
import type { PushTimers } from "@anhourmail/jmap-client/push";

import type { PushEvent, PushHub, PushSubscription, PushTarget } from "./push-hub";

/**
 * The browser's side of webmail push: a server-sent event stream fed by the push hub (`./push-hub`). Events:
 * `ready` (push is up: catch up once), `down` (it went away: poll until `ready`), `state` (`{ Email?, Mailbox? }`, the
 * new state names), `end` (`{ reason }`: don't reconnect). A comment every `heartbeatMs` keeps proxies and the
 * browser from treating the quiet stream as dead; the stream ends by itself after about `maxStreamMs` and the browser's
 * EventSource opens a new one (passing `route()`'s checks again).
 */

export const PUSH_STREAM = {
  /** Comment line interval: below common proxy read timeouts (60 s). */
  heartbeatMs: 25_000,
  /** A stream's lifetime before the browser reconnects (± 10 %). */
  maxStreamMs: 30 * 60_000,
  /** The browser's reconnect delay after a drop (`retry:`). */
  retryMs: 5_000,
} as const;

/** A JMAP account id as the push route accepts it. */
export const isPushAccount = (v: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** One event in the stream's wire format. */
export function sseEvent(e: PushEvent): string {
  switch (e.type) {
    case "ready":
    case "down":
      return `event: ${e.type}\ndata: {}\n\n`;
    case "state":
      return `event: state\ndata: ${JSON.stringify(e.changed)}\n\n`;
    case "end":
      return `event: end\ndata: ${JSON.stringify({ reason: e.reason })}\n\n`;
  }
}

const defaultTimers: PushTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

/**
 * The stream response for `target` (checked by the route), or null when the hub is at a cap. It ends when the
 * browser goes (`signal`), when the hub ends the channel, or after its lifetime.
 */
export function pushStream(
  hub: PushHub,
  sessionId: string,
  target: PushTarget,
  signal: AbortSignal,
  opts: { timers?: PushTimers; random?: () => number } = {},
): Response | null {
  const timers = opts.timers ?? defaultTimers;
  const random = opts.random ?? Math.random;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  /** Events before the stream started (`ready` from a channel already up). */
  const early: string[] = [];
  let heartbeat: unknown = null;
  let lifetime: unknown = null;
  let sub: PushSubscription | null = null;

  const write = (chunk: string) => {
    if (closed) return;
    if (!controller) {
      early.push(chunk);
      return;
    }
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      finish();
    }
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    sub?.unsubscribe();
    if (heartbeat !== null) timers.clearInterval(heartbeat);
    if (lifetime !== null) timers.clearTimeout(lifetime);
    signal.removeEventListener("abort", finish);
    try {
      controller?.close();
    } catch {
      // Already closed by the browser going away.
    }
  };

  sub = hub.subscribe(sessionId, target, (e) => {
    write(sseEvent(e));
    if (e.type === "end") finish();
  });
  if (!sub) return null;
  if (signal.aborted) {
    finish();
    return null;
  }
  signal.addEventListener("abort", finish);

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (closed) {
        c.close();
        return;
      }
      c.enqueue(encoder.encode(`retry: ${String(PUSH_STREAM.retryMs)}\n: push\n\n`));
      for (const chunk of early.splice(0)) c.enqueue(encoder.encode(chunk));
      heartbeat = timers.setInterval(() => {
        write(": ping\n\n");
      }, PUSH_STREAM.heartbeatMs);
      lifetime = timers.setTimeout(finish, PUSH_STREAM.maxStreamMs * (0.9 + random() * 0.2));
    },
    cancel() {
      finish();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // No caching, and no compression or transformation on the way (it would hold events back).
      "Cache-Control": "no-store, no-transform",
      // NGINX: pass each event on as it comes (production also sets `proxy_buffering off` for this path).
      "X-Accel-Buffering": "no",
    },
  });
}
