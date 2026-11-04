// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { PushTimers } from "@anhourmail/jmap-client/push";

import { PushHub, type PushHubDeps, type PushTarget } from "./push-hub";
import { isPushAccount, PUSH_STREAM, pushStream, sseEvent } from "./push-stream";

const SID = "a".repeat(43);
const T: PushTarget = { username: "me@x.test", accountId: "b", accessToken: "secret-token", expiresAt: 3_600_000 };

function manual() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: PushTimers = {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (h) => pending.delete(h as number),
    setInterval: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearInterval: (h) => pending.delete(h as number),
  };
  const fire = (pred: (ms: number) => boolean) => {
    for (const t of [...pending.values()]) if (pred(t.ms)) t.fn();
  };
  return { timers, fire, size: () => pending.size };
}

function setup() {
  let handlers: Parameters<PushHubDeps["connect"]>[1] | null = null;
  const hub = new PushHub({
    target: async () => ({ kind: "ok", target: T }),
    connect: (_t, h) => {
      handlers = h;
      return { close: () => undefined, open: true };
    },
    timers: manual().timers,
  });
  const up = () => {
    if (!handlers) throw new Error("not connected");
    return handlers;
  };
  return { hub, up };
}

async function readSome(res: Response, until: string): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes(until)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  reader.releaseLock();
  return text;
}

async function readAll(res: Response): Promise<string> {
  return new TextDecoder().decode(await new Response(res.body).arrayBuffer());
}

describe("sseEvent", () => {
  it("writes each event in the event-stream format", () => {
    expect(sseEvent({ type: "ready" })).toBe("event: ready\ndata: {}\n\n");
    expect(sseEvent({ type: "down" })).toBe("event: down\ndata: {}\n\n");
    expect(sseEvent({ type: "state", changed: { Email: "s1" } })).toBe('event: state\ndata: {"Email":"s1"}\n\n');
    expect(sseEvent({ type: "end", reason: "signedout" })).toBe('event: end\ndata: {"reason":"signedout"}\n\n');
  });
});

describe("isPushAccount", () => {
  it("accepts JMAP account ids and nothing else", () => {
    expect(isPushAccount("b")).toBe(true);
    expect(isPushAccount("Ab_9-z")).toBe(true);
    expect(isPushAccount("")).toBe(false);
    expect(isPushAccount("a b")).toBe(false);
    expect(isPushAccount("x".repeat(65))).toBe(false);
  });
});

describe("pushStream", () => {
  it("streams events with the headers that keep proxies from holding them back", async () => {
    const { hub, up } = setup();
    const t = manual();
    const ac = new AbortController();
    const res = pushStream(hub, SID, T, ac.signal, { timers: t.timers, random: () => 0.5 });
    if (!res) throw new Error("no stream");
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    up().onOpen();
    up().onStateChange({ b: { Email: "s9" } });
    const text = await readSome(res, "s9");
    expect(text).toContain(`retry: ${String(PUSH_STREAM.retryMs)}`);
    expect(text).toContain("event: ready");
    expect(text).toContain('event: state\ndata: {"Email":"s9"}');
    // Never the token, the address or the session.
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("me@x.test");
    expect(text).not.toContain(SID);
    t.fire((ms) => ms === PUSH_STREAM.heartbeatMs);
    expect(await readSome(res, "ping")).toContain(": ping");
    ac.abort();
    expect(hub.stats().streams).toBe(0);
  });

  it("a channel already up says ready first", async () => {
    const { hub, up } = setup();
    const first = pushStream(hub, SID, T, new AbortController().signal, { timers: manual().timers });
    up().onOpen();
    const res = pushStream(hub, SID, T, new AbortController().signal, { timers: manual().timers });
    if (!res || !first) throw new Error("no stream");
    expect(await readSome(res, "ready")).toContain("event: ready");
  });

  it("ends with the end event when the hub ends the channel", async () => {
    const { hub } = setup();
    const res = pushStream(hub, SID, T, new AbortController().signal, { timers: manual().timers });
    if (!res) throw new Error("no stream");
    hub.closeSession(SID);
    const text = await readAll(res);
    expect(text).toContain('event: end\ndata: {"reason":"signedout"}');
    expect(hub.stats().streams).toBe(0);
  });

  it("ends by itself after its lifetime, leaving the reconnect to the browser", async () => {
    const { hub } = setup();
    const t = manual();
    const res = pushStream(hub, SID, T, new AbortController().signal, { timers: t.timers, random: () => 1 });
    if (!res) throw new Error("no stream");
    t.fire((ms) => ms === PUSH_STREAM.maxStreamMs * 1.1);
    const text = await readAll(res);
    expect(text).not.toContain("event: end");
    expect(hub.stats().streams).toBe(0);
    expect(t.size()).toBe(0);
  });

  it("the browser cancelling the body unsubscribes", async () => {
    const { hub } = setup();
    const res = pushStream(hub, SID, T, new AbortController().signal, { timers: manual().timers });
    if (!res) throw new Error("no stream");
    await res.body?.cancel();
    expect(hub.stats().streams).toBe(0);
  });

  it("null when the hub is full, and nothing left behind for an aborted request", () => {
    const hub = new PushHub({
      target: async () => ({ kind: "ok", target: T }),
      connect: () => ({ close: () => undefined, open: false }),
      timers: manual().timers,
      limits: { streams: 0 },
    });
    expect(pushStream(hub, SID, T, new AbortController().signal)).toBeNull();
    const { hub: h2 } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(pushStream(h2, SID, T, ac.signal)).toBeNull();
    expect(h2.stats().streams).toBe(0);
  });
});
