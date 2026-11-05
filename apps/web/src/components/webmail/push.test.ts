// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import {
  type BroadcastChannelLike,
  parseSse,
  pushRetryDelay,
  type PushEnv,
  type PushHandlers,
  readChanged,
  startPush,
} from "./push";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A stream the test writes server-sent events into. */
function sseResponse() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    res: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    send: (text: string) => {
      try {
        ctrl?.enqueue(enc.encode(text));
      } catch {
        // The reader went away.
      }
    },
    end: () => ctrl?.close(),
    fail: () => ctrl?.error(new Error("network")),
  };
}

/** One browser: Web Locks (FIFO, per name) and BroadcastChannel (every other instance of the name) between tabs. */
function browser() {
  const held = new Map<string, { queue: { cb: () => Promise<void>; signal: AbortSignal }[]; busy: boolean }>();
  const run = (name: string) => {
    const l = held.get(name);
    if (!l || l.busy) return;
    const next = l.queue.shift();
    if (!next) return;
    l.busy = true;
    void next.cb().finally(() => {
      l.busy = false;
      run(name);
    });
  };
  const locks: NonNullable<PushEnv["locks"]> = {
    request: (name, opts, cb) =>
      new Promise((resolve, reject) => {
        let l = held.get(name);
        if (!l) {
          l = { queue: [], busy: false };
          held.set(name, l);
        }
        const entry = {
          cb: async () => {
            await cb();
            resolve(undefined);
          },
          signal: opts.signal,
        };
        l.queue.push(entry);
        opts.signal.addEventListener("abort", () => {
          const q = held.get(name)?.queue ?? [];
          const i = q.indexOf(entry);
          if (i !== -1) {
            q.splice(i, 1);
            reject(new Error("aborted"));
          }
        });
        run(name);
      }),
  };
  const channels = new Set<FakeChannel>();
  class FakeChannel implements BroadcastChannelLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      channels.add(this);
    }
    postMessage(m: unknown) {
      for (const c of channels)
        if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data: m }));
    }
    close() {
      channels.delete(this);
    }
  }
  return { locks, BroadcastChannel: FakeChannel };
}

function tab(
  b: ReturnType<typeof browser> | null,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  waits: { ms: number; fn: () => void }[] = [],
) {
  const events: string[] = [];
  const handlers: PushHandlers = {
    onUp: () => events.push("up"),
    onDown: () => events.push("down"),
    onState: (c) => events.push(`state:${JSON.stringify(c)}`),
    onSignedOut: () => events.push("signedout"),
  };
  const env: PushEnv = {
    fetch: (input, init) => fetchImpl(input instanceof Request ? input.url : input.toString(), init),
    locks: b?.locks ?? null,
    BroadcastChannel: b?.BroadcastChannel ?? null,
    setTimeout: (fn, ms) => {
      const w = { ms, fn };
      waits.push(w);
      return w;
    },
    clearTimeout: (h) => {
      const i = waits.indexOf(h as { ms: number; fn: () => void });
      if (i !== -1) waits.splice(i, 1);
    },
    // The first draw names the tab; later ones are the jitter.
    random: (() => {
      let named = false;
      return () => {
        if (named) return 0.5;
        named = true;
        return Math.random();
      };
    })(),
  };
  const stop = startPush("/api/webmail/push?account=b", "b", handlers, env);
  return { events, stop, waits };
}

describe("parseSse", () => {
  it("splits whole events and keeps the rest", () => {
    const r = parseSse(
      'retry: 5000\n: push\n\nevent: ready\ndata: {}\n\nevent: state\r\ndata: {"Email":"s"}\r\n\r\nevent: do',
    );
    expect(r.events).toEqual([
      { event: "ready", data: "{}" },
      { event: "state", data: '{"Email":"s"}' },
    ]);
    expect(r.rest).toBe("event: do");
  });

  it("joins data lines and reads fields without a value", () => {
    expect(parseSse("data: a\ndata: b\n\nevent\n\n").events).toEqual([
      { event: "message", data: "a\nb" },
      { event: "", data: "" },
    ]);
  });
});

describe("readChanged", () => {
  it("keeps well-formed Email and Mailbox states only", () => {
    expect(readChanged('{"Email":"s1","Mailbox":"m1","Thread":"t"}')).toEqual({ Email: "s1", Mailbox: "m1" });
    expect(readChanged('{"Email":"<x>"}')).toBeNull();
    expect(readChanged('{"Email":5}')).toBeNull();
    expect(readChanged("null")).toBeNull();
    expect(readChanged("{")).toBeNull();
  });
});

describe("pushRetryDelay", () => {
  it("starts at 5 s, doubles and stops at 10 minutes, jittered", () => {
    expect(pushRetryDelay(1, () => 1)).toBe(5_000);
    expect(pushRetryDelay(2, () => 1)).toBe(10_000);
    expect(pushRetryDelay(1, () => 0)).toBe(2_500);
    expect(pushRetryDelay(50, () => 1)).toBe(600_000);
  });
});

describe("startPush", () => {
  it("one tab leads: it opens the stream and every tab hears the events", async () => {
    const b = browser();
    const s = sseResponse();
    const fetchA = vi.fn(async (_url: string) => s.res);
    const fetchB = vi.fn(async () => sseResponse().res);
    const a = tab(b, fetchA);
    const other = tab(b, fetchB);
    await flush();
    expect(fetchA).toHaveBeenCalledOnce();
    expect(fetchB).not.toHaveBeenCalled();
    expect(fetchA.mock.calls[0]?.[0]).toBe("/api/webmail/push?account=b");
    s.send('retry: 5000\n\nevent: ready\ndata: {}\n\nevent: state\ndata: {"Email":"e2"}\n\n');
    await flush();
    expect(a.events).toEqual(["up", 'state:{"Email":"e2"}']);
    expect(other.events).toEqual(["up", 'state:{"Email":"e2"}']);
    a.stop();
    other.stop();
  });

  it("a tab opening later hears that push is up, without the others catching up again", async () => {
    const b = browser();
    const s = sseResponse();
    const a = tab(b, async () => s.res);
    const second = tab(b, async () => sseResponse().res);
    await flush();
    s.send("event: ready\ndata: {}\n\n");
    await flush();
    const third = tab(b, async () => sseResponse().res);
    await flush();
    expect(third.events).toEqual(["up"]);
    expect(second.events).toEqual(["up"]);
    a.stop();
    second.stop();
    third.stop();
  });

  it("when the leading tab closes the next one opens the stream", async () => {
    const b = browser();
    const first = sseResponse();
    const a = tab(b, async () => first.res);
    const nextStream = sseResponse();
    const fetchB = vi.fn(async () => nextStream.res);
    const other = tab(b, fetchB);
    await flush();
    a.stop();
    await flush();
    expect(fetchB).toHaveBeenCalledOnce();
    nextStream.send("event: ready\ndata: {}\n\n");
    await flush();
    expect(other.events).toEqual(["up"]);
    other.stop();
  });

  it("down while the server's upstream is lost, up again when it is back", async () => {
    const s = sseResponse();
    const t = tab(null, async () => s.res);
    await flush();
    s.send("event: ready\ndata: {}\n\nevent: down\ndata: {}\n\nevent: down\ndata: {}\n\nevent: ready\ndata: {}\n\n");
    await flush();
    expect(t.events).toEqual(["up", "down", "up"]);
    t.stop();
  });

  it("a stream that ends opens again soon; one that fails backs off", async () => {
    const streams = [sseResponse(), sseResponse(), sseResponse()];
    let n = 0;
    const fetchFn = vi.fn(async () => (streams[n++] ?? sseResponse()).res);
    const t = tab(null, fetchFn);
    await flush();
    streams[0]?.send("event: ready\ndata: {}\n\n");
    await flush();
    streams[0]?.end();
    await flush();
    expect(t.events).toEqual(["up", "down"]);
    expect(t.waits.map((w) => w.ms)).toEqual([625]);
    t.waits.shift()?.fn();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    streams[1]?.fail();
    await flush();
    expect(t.waits.map((w) => w.ms)).toEqual([3_750]);
    t.waits.shift()?.fn();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    t.stop();
  });

  it("503, 429 and network errors back off; 403 and 409 stop push for the page", async () => {
    for (const status of [503, 429]) {
      const t = tab(null, async () => new Response(null, { status }));
      await flush();
      expect(t.waits).toHaveLength(1);
      t.stop();
    }
    const offline = tab(null, async () => {
      throw new TypeError("offline");
    });
    await flush();
    expect(offline.waits).toHaveLength(1);
    offline.stop();
    // 204 with an empty body (what some browsers hand over) is still "no push".
    const empty = vi.fn(
      async () =>
        ({
          status: 204,
          ok: true,
          body: new ReadableStream({
            start: (c) => {
              c.close();
            },
          }),
        }) as unknown as Response,
    );
    const none = tab(null, empty);
    await flush();
    expect(none.waits).toHaveLength(0);
    expect(empty).toHaveBeenCalledOnce();
    none.stop();
    for (const status of [204, 400, 403, 409]) {
      const f = vi.fn(async () => new Response(null, { status }));
      const t = tab(null, f);
      await flush();
      expect(t.waits).toHaveLength(0);
      expect(f).toHaveBeenCalledOnce();
      expect(t.events).toEqual([]);
      t.stop();
    }
  });

  it("signed out (401, or the server ending the stream for it): every tab is told, nothing reconnects", async () => {
    const b = browser();
    const s = sseResponse();
    const f = vi.fn(async () => s.res);
    const a = tab(b, f);
    const other = tab(b, async () => sseResponse().res);
    await flush();
    s.send('event: ready\ndata: {}\n\nevent: end\ndata: {"reason":"signedout"}\n\n');
    await flush();
    expect(a.events).toEqual(["up", "down", "signedout"]);
    expect(other.events).toEqual(["up", "down", "signedout"]);
    expect(a.waits).toHaveLength(0);
    a.stop();
    other.stop();

    const t = tab(null, async () => new Response(null, { status: 401 }));
    await flush();
    expect(t.events).toEqual(["signedout"]);
    t.stop();
  });

  it("moved ends push for the page; shutdown reconnects", async () => {
    const moved = sseResponse();
    const t = tab(null, async () => moved.res);
    await flush();
    moved.send('event: end\ndata: {"reason":"moved"}\n\n');
    await flush();
    expect(t.waits).toHaveLength(0);
    t.stop();
    const shut = sseResponse();
    const u = tab(null, async () => shut.res);
    await flush();
    shut.send("event: end\ndata: nonsense\n\n");
    await flush();
    expect(u.waits).toHaveLength(1);
    u.stop();
  });

  it("renewed (the session's new id after a password change) opens the stream again soon, never signed out", async () => {
    const b = browser();
    const streams = [sseResponse(), sseResponse()];
    let n = 0;
    const f = vi.fn(async () => (streams[n++] ?? sseResponse()).res);
    const a = tab(b, f);
    const other = tab(b, async () => sseResponse().res);
    await flush();
    streams[0]?.send('event: ready\ndata: {}\n\nevent: end\ndata: {"reason":"renewed"}\n\n');
    await flush();
    expect(a.events).toEqual(["up", "down"]);
    expect(other.events).toEqual(["up", "down"]);
    // Like a planned end: a short jittered wait, not the failure backoff.
    expect(a.waits.map((w) => w.ms)).toEqual([625]);
    a.waits.shift()?.fn();
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
    streams[1]?.send("event: ready\ndata: {}\n\n");
    await flush();
    expect(a.events).toEqual(["up", "down", "up"]);
    a.stop();
    other.stop();
  });

  it("opens the stream with the fetch it is given, the browser's for everything else", async () => {
    const s = sseResponse();
    const given = vi.fn(async () => s.res);
    const stop = startPush(
      "/api/webmail/push?account=b",
      "b",
      {
        onUp: () => undefined,
        onDown: () => undefined,
        onState: () => undefined,
        onSignedOut: () => undefined,
      },
      { fetch: given, locks: null, BroadcastChannel: null },
    );
    await flush();
    expect(given).toHaveBeenCalledOnce();
    expect(given.mock.calls[0]).toMatchObject(["/api/webmail/push?account=b", { credentials: "same-origin" }]);
    stop();
  });

  it("ignores malformed state events and gives up a stream that never ends an event", async () => {
    const s = sseResponse();
    const t = tab(null, async () => s.res);
    await flush();
    s.send('event: state\ndata: {"Email":"<b>"}\n\n');
    s.send("x".repeat(70_000));
    await flush();
    expect(t.events).toEqual([]);
    expect(t.waits).toHaveLength(1);
    t.stop();
  });

  it("stopping aborts the stream and delivers nothing more", async () => {
    let signal: AbortSignal | undefined;
    const s = sseResponse();
    const t = tab(null, async (_u, init) => {
      signal = init?.signal ?? undefined;
      return s.res;
    });
    await flush();
    t.stop();
    expect(signal?.aborted).toBe(true);
    s.send("event: ready\ndata: {}\n\n");
    await flush();
    expect(t.events).toEqual([]);
  });

  it("a tab waiting for the lock leaves the queue when it stops", async () => {
    const b = browser();
    const a = tab(b, async () => sseResponse().res);
    const f = vi.fn(async () => sseResponse().res);
    const other = tab(b, f);
    await flush();
    other.stop();
    a.stop();
    await flush();
    expect(f).not.toHaveBeenCalled();
  });
});
