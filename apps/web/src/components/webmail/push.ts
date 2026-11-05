// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail push in the browser (docs/internal/05-webmail.md "Push"). The BFF's stream (`GET /api/webmail/push`) says
 * which data types of the mailbox changed; the app then asks for those changes only. Tabs of the same mailbox share
 * one stream: the tab holding a Web Lock (`navigator.locks`) for the mailbox leads — it opens the stream and passes
 * every event on over a `BroadcastChannel` — and when it closes the lock goes to the next tab, which opens the stream
 * again. Without Web Locks or BroadcastChannel each tab opens its own stream (the server shares one upstream channel
 * between them anyway).
 *
 * Read with `fetch`, not `EventSource`, so the answer's status is known: 401 → signed out (the app's own checks run the
 * sign-in flow), 400/403/409 → no push for this page (a mailbox shared with the person, or another mailbox active),
 * 429/503 or a network error → retried with backoff while the app polls. An `end` with reason `renewed` (the session
 * moved to a new id after the mailbox's own password change) opens the stream again at once, with the new cookie.
 */

/** New state names per data type, as the stream sends them. */
export type PushChanged = { Email?: string; Mailbox?: string };

export type PushHandlers = {
  /** Push is up: catch up once, then rely on it (the app keeps a slow safety check). */
  onUp: () => void;
  /** Push is down: poll until it is up again. */
  onDown: () => void;
  onState: (changed: PushChanged) => void;
  /** The server ended the session's stream because the session ended. */
  onSignedOut: () => void;
};

/** Between tabs. `up` answering a new tab's `hello` names that tab (`to`), so the others don't catch up again. */
type Msg =
  | { k: "up"; to?: string }
  | { k: "down" }
  | { k: "state"; c: PushChanged }
  | { k: "signedout" }
  | { k: "hello"; from: string };

export type PushEnv = {
  fetch: typeof fetch;
  locks: { request: (name: string, opts: { signal: AbortSignal }, cb: () => Promise<void>) => Promise<unknown> } | null;
  BroadcastChannel: (new (name: string) => BroadcastChannelLike) | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  random: () => number;
};

export type BroadcastChannelLike = {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

/** One server-sent event. */
export type SseEvent = { event: string; data: string };

/**
 * Splits a server-sent event stream buffer into whole events (`event:` / `data:` lines ended by a blank line;
 * comments and `retry:` ignored) and the incomplete rest.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const text = buffer.replace(/\r\n?/g, "\n");
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0 || event !== "message") events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

const STATE = /^[A-Za-z0-9_:.-]{1,128}$/;

/** The `state` event's payload, keeping only well-formed Email / Mailbox state names. */
export function readChanged(data: string): PushChanged | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const out: PushChanged = {};
  if (typeof o.Email === "string" && STATE.test(o.Email)) out.Email = o.Email;
  if (typeof o.Mailbox === "string" && STATE.test(o.Mailbox)) out.Mailbox = o.Mailbox;
  return out.Email === undefined && out.Mailbox === undefined ? null : out;
}

/** The wait before opening the stream again after `failures` failures in a row: 5 s doubling to 10 min, jittered. */
export function pushRetryDelay(failures: number, random: () => number): number {
  const base = Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, Math.min(failures - 1, 10)));
  return base * (0.5 + random() / 2);
}

const isMsg = (m: unknown): m is Msg =>
  typeof m === "object" &&
  m !== null &&
  ["up", "down", "state", "signedout", "hello"].includes(String((m as { k?: unknown }).k));

/** How a stream ended. */
type Outcome =
  | { kind: "status"; status: number }
  | { kind: "end"; reason: string }
  | { kind: "closed" }
  | { kind: "error" }
  | { kind: "aborted" };

function browserEnv(): PushEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const locks: PushEnv["locks"] = nav && "locks" in nav ? nav.locks : null;
  return {
    fetch: (input, init) => fetch(input, init),
    locks,
    BroadcastChannel:
      typeof BroadcastChannel === "undefined"
        ? null
        : (BroadcastChannel as unknown as new (name: string) => BroadcastChannelLike),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => {
      window.clearTimeout(h as number);
    },
    random: Math.random,
  };
}

/**
 * Starts push for one mailbox (`key`, its JMAP account id) from `url`. Returns `stop`, which closes the stream (or
 * leaves the queue for the lock) and the channel.
 */
export function startPush(
  url: string,
  key: string,
  handlers: PushHandlers,
  overrides: Partial<PushEnv> = {},
): () => void {
  const env: PushEnv = { ...browserEnv(), ...overrides };
  const life = new AbortController();
  /** Read through a function: the page can go away during any wait. */
  const aborted = () => life.signal.aborted;
  const name = `anhourmail-push:${key}`;
  const channel = env.BroadcastChannel && env.locks ? new env.BroadcastChannel(name) : null;
  let leading = false;
  let up = false;
  /** This tab, for answers meant for it only. */
  const me = env.random().toString(36).slice(2);

  const deliver = (m: Msg) => {
    if (life.signal.aborted) return;
    if (m.k === "up") handlers.onUp();
    else if (m.k === "down") handlers.onDown();
    else if (m.k === "state") handlers.onState(m.c);
    else if (m.k === "signedout") handlers.onSignedOut();
  };
  /** The leader tells itself and every other tab. */
  const broadcast = (m: Msg) => {
    deliver(m);
    try {
      channel?.postMessage(m);
    } catch {
      // The channel closed (page going away).
    }
  };
  if (channel) {
    channel.onmessage = (ev) => {
      const m = ev.data;
      if (!isMsg(m)) return;
      if (m.k === "hello") {
        // A tab opened: tell it whether push is up (it polls until then).
        if (leading && up) channel.postMessage({ k: "up", to: m.from } satisfies Msg);
        return;
      }
      if (m.k === "up" && m.to !== undefined && m.to !== me) return;
      if (!leading) deliver(m);
    };
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (life.signal.aborted) {
        resolve();
        return;
      }
      const h = env.setTimeout(() => {
        life.signal.removeEventListener("abort", done);
        resolve();
      }, ms);
      const done = () => {
        env.clearTimeout(h);
        resolve();
      };
      life.signal.addEventListener("abort", done, { once: true });
    });

  const stream = async (): Promise<Outcome> => {
    let res: Response;
    try {
      res = await env.fetch(url, {
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "same-origin",
        signal: life.signal,
      });
    } catch {
      return life.signal.aborted ? { kind: "aborted" } : { kind: "error" };
    }
    // Only a 200 is a stream (204 "no push for this tab" may still come with an empty body).
    if (res.status !== 200 || !res.body) return { kind: "status", status: res.status === 200 ? 502 : res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // The page going away ends the read even where aborting the request doesn't end its body.
    const cancel = () => {
      reader.cancel().catch(() => undefined);
    };
    life.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return aborted() ? { kind: "aborted" } : { kind: "closed" };
        buffer += decoder.decode(value, { stream: true });
        // A stream that never sends a blank line can't grow the buffer without bound.
        if (buffer.length > 65_536) return { kind: "error" };
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.event === "ready") {
            up = true;
            broadcast({ k: "up" });
          } else if (e.event === "down") {
            if (up) broadcast({ k: "down" });
            up = false;
          } else if (e.event === "state") {
            const c = readChanged(e.data);
            if (c) broadcast({ k: "state", c });
          } else if (e.event === "end") {
            let reason = "";
            try {
              const r = (JSON.parse(e.data) as { reason?: unknown }).reason;
              reason = typeof r === "string" ? r : "";
            } catch {
              // Treated as an ordinary end.
            }
            return { kind: "end", reason };
          }
        }
      }
    } catch {
      return life.signal.aborted ? { kind: "aborted" } : { kind: "error" };
    } finally {
      life.signal.removeEventListener("abort", cancel);
      reader.cancel().catch(() => undefined);
    }
  };

  /** Runs while this tab leads; resolves only when push is over for this page (or it closes). */
  const lead = async () => {
    leading = true;
    let failures = 0;
    while (!life.signal.aborted) {
      const out = await stream();
      if (up) {
        up = false;
        broadcast({ k: "down" });
      }
      if (out.kind === "aborted" || aborted()) return;
      if ((out.kind === "status" && out.status === 401) || (out.kind === "end" && out.reason === "signedout")) {
        broadcast({ k: "signedout" });
        break;
      }
      // Not for this page: a mailbox shared with the person (403), or the session shows another mailbox now.
      if (out.kind === "status" && out.status < 500 && out.status !== 429) break;
      if (out.kind === "end" && out.reason === "moved") break;
      // The stream's planned end, or the session moved to a new id (its own password change): open the next one soon
      // (with the new cookie). Anything else: back off.
      if (out.kind === "closed" || (out.kind === "end" && out.reason === "renewed")) {
        failures = 0;
        await wait(250 + env.random() * 750);
      } else {
        failures += 1;
        await wait(pushRetryDelay(failures, env.random));
      }
    }
    // Keep the lock until the page goes, so the other tabs don't each try again.
    await new Promise<void>((resolve) => {
      if (life.signal.aborted) resolve();
      else
        life.signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
    });
  };

  if (env.locks && channel) {
    channel.postMessage({ k: "hello", from: me } satisfies Msg);
    env.locks.request(name, { signal: life.signal }, lead).catch(() => undefined);
  } else {
    void lead();
  }

  return () => {
    life.abort();
    if (channel) {
      channel.onmessage = null;
      channel.close();
    }
  };
}
