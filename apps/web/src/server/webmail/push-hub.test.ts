// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import type { PushChannel, PushTimers, StateChange } from "@anhourmail/jmap-client/push";

import { type PushEvent, PushHub, type PushHubDeps, type PushTarget, type PushTargetResult } from "./push-hub";

const SID = "a".repeat(43);
const SID2 = "b".repeat(43);
const T: PushTarget = { username: "me@x.test", accountId: "b", accessToken: "tok-1", expiresAt: 3_600_000 };

/** Lets promise chains (a check, then its reconnect) run to the end. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Timers run by hand: `advance(ms)` fires everything due, in order. */
function clock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const timers: PushTimers = {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: now + ms, fn, every: null });
      return seq;
    },
    clearTimeout: (h) => pending.delete(h as number),
    setInterval: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: now + ms, fn, every: ms });
      return seq;
    },
    clearInterval: (h) => pending.delete(h as number),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every === null) pending.delete(id);
      else t.at += t.every;
      t.fn();
      // Let the async work a timer started settle.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
  };
  return { timers, advance, now: () => now, pending: () => pending.size };
}

type Upstream = {
  target: PushTarget;
  open: () => void;
  push: (c: StateChange) => void;
  drop: () => void;
  closed: boolean;
};

function setup(opts: { target?: (sid: string, o: { connect: boolean }) => Promise<PushTargetResult> } = {}) {
  const c = clock();
  const upstreams: Upstream[] = [];
  const target = vi.fn(opts.target ?? (async (): Promise<PushTargetResult> => ({ kind: "ok", target: T })));
  const connect: PushHubDeps["connect"] = (t, h) => {
    const u: Upstream = {
      target: t,
      closed: false,
      open: () => {
        h.onOpen();
      },
      push: (ch) => {
        h.onStateChange(ch);
      },
      drop: () => {
        h.onClose({ code: 1006, opened: true });
      },
    };
    upstreams.push(u);
    const ch: PushChannel = {
      close: () => {
        u.closed = true;
      },
      get open() {
        return !u.closed;
      },
    };
    return ch;
  };
  const hub = new PushHub({
    target,
    connect,
    now: c.now,
    timers: c.timers,
    random: () => 0.5,
    limits: { channels: 2, streamsPerChannel: 2, streams: 3 },
  });
  const listen = () => {
    const events: PushEvent[] = [];
    return { events, fn: (e: PushEvent) => events.push(e) };
  };
  return { hub, upstreams, target, listen, ...c };
}

describe("PushHub", () => {
  it("opens one upstream per session and mailbox and fans state changes out to every stream", () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    const b = listen();
    hub.subscribe(SID, T, a.fn);
    hub.subscribe(SID, T, b.fn);
    expect(upstreams).toHaveLength(1);
    upstreams[0]?.open();
    upstreams[0]?.push({ b: { Email: "s2", Thread: "t2", Mailbox: "m2" }, other: { Email: "x" } });
    const want: PushEvent[] = [{ type: "ready" }, { type: "state", changed: { Email: "s2", Mailbox: "m2" } }];
    expect(a.events).toEqual(want);
    expect(b.events).toEqual(want);
    expect(hub.stats()).toEqual({ channels: 1, streams: 2, up: 1 });
  });

  it("passes nothing on for other accounts or other types", () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    upstreams[0]?.push({ c: { Email: "s" } });
    upstreams[0]?.push({ b: { Thread: "t", EmailDelivery: "d" } });
    expect(a.events).toEqual([]);
  });

  it("tells a stream joining a channel that is up at once", () => {
    const { hub, upstreams, listen } = setup();
    hub.subscribe(SID, T, listen().fn);
    upstreams[0]?.open();
    const late = listen();
    hub.subscribe(SID, T, late.fn);
    expect(late.events).toEqual([{ type: "ready" }]);
  });

  it("sessions never share a channel", () => {
    const { hub, upstreams, listen } = setup();
    hub.subscribe(SID, T, listen().fn);
    hub.subscribe(SID2, T, listen().fn);
    expect(upstreams).toHaveLength(2);
  });

  it("a session switching mailbox ends its old channel as moved", () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    hub.subscribe(SID, { ...T, username: "other@x.test", accountId: "c" }, listen().fn);
    expect(a.events).toEqual([{ type: "end", reason: "moved" }]);
    expect(upstreams[0]?.closed).toBe(true);
    expect(hub.stats()).toMatchObject({ channels: 1, streams: 1 });
  });

  it("the same address with another account id is a new channel", () => {
    const { hub, listen } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    hub.subscribe(SID, { ...T, accountId: "z" }, listen().fn);
    expect(a.events).toEqual([{ type: "end", reason: "moved" }]);
  });

  it("refuses over the caps (the route then answers 503 and the tab polls)", () => {
    const { hub, listen } = setup();
    expect(hub.subscribe(SID, T, listen().fn)).not.toBeNull();
    expect(hub.subscribe(SID, T, listen().fn)).not.toBeNull();
    // Streams per channel: 2.
    expect(hub.subscribe(SID, T, listen().fn)).toBeNull();
    expect(hub.subscribe(SID2, T, listen().fn)).not.toBeNull();
    // Streams per process: 3.
    expect(hub.subscribe("c".repeat(43), T, listen().fn)).toBeNull();
    expect(hub.stats()).toMatchObject({ channels: 2, streams: 3 });
  });

  it("refuses a third channel per process", () => {
    const { hub, listen } = setup();
    const s = hub.subscribe(SID, T, listen().fn);
    hub.subscribe(SID2, T, listen().fn);
    s?.unsubscribe();
    expect(hub.subscribe("c".repeat(43), T, listen().fn)).toBeNull();
  });

  it("closes the upstream a while after the last stream left, unless one comes back", async () => {
    const { hub, upstreams, listen, advance } = setup();
    const s = hub.subscribe(SID, T, listen().fn);
    s?.unsubscribe();
    s?.unsubscribe();
    expect(hub.stats().streams).toBe(0);
    await advance(10_000);
    const again = hub.subscribe(SID, T, listen().fn);
    await advance(60_000);
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0]?.closed).toBe(false);
    again?.unsubscribe();
    await advance(30_000);
    expect(upstreams[0]?.closed).toBe(true);
    expect(hub.stats().channels).toBe(0);
  });

  it("a lost upstream: streams hear down, it reconnects at once with a fresh target, then ready", async () => {
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    upstreams[0]?.open();
    target.mockResolvedValueOnce({ kind: "ok", target: { ...T, accessToken: "tok-2" } });
    upstreams[0]?.drop();
    expect(a.events.at(-1)).toEqual({ type: "down" });
    await advance(0);
    expect(target).toHaveBeenLastCalledWith(SID, { connect: true });
    expect(upstreams).toHaveLength(2);
    expect(upstreams[1]?.target.accessToken).toBe("tok-2");
    upstreams[1]?.open();
    expect(a.events.at(-1)).toEqual({ type: "ready" });
  });

  it("backs off with jitter while the upstream keeps failing, and resets once it opens", async () => {
    const { hub, upstreams, listen, advance } = setup();
    hub.subscribe(SID, T, listen().fn);
    upstreams[0]?.drop();
    await advance(0);
    expect(upstreams).toHaveLength(2);
    upstreams[1]?.drop();
    // Second failure: 2 s × 0.75 jitter.
    await advance(1_400);
    expect(upstreams).toHaveLength(2);
    await advance(200);
    expect(upstreams).toHaveLength(3);
    upstreams[2]?.drop();
    await advance(3_000);
    expect(upstreams).toHaveLength(4);
    upstreams[3]?.open();
    upstreams[3]?.drop();
    await advance(0);
    expect(upstreams).toHaveLength(5);
  });

  it("an upstream that drops before ever opening says nothing to streams", async () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    upstreams[0]?.drop();
    expect(a.events).toEqual([]);
  });

  it("ends the channel when reconnecting finds the session signed out or moved", async () => {
    for (const kind of ["signedout", "moved"] as const) {
      const { hub, upstreams, listen, advance, target } = setup();
      const a = listen();
      hub.subscribe(SID, T, a.fn);
      target.mockResolvedValueOnce({ kind });
      upstreams[0]?.drop();
      await advance(0);
      expect(a.events.at(-1)).toEqual({ type: "end", reason: kind });
      expect(hub.stats()).toEqual({ channels: 0, streams: 0, up: 0 });
    }
  });

  it("keeps trying while the mail server or the session store can't say", async () => {
    const { hub, upstreams, listen, advance, target } = setup();
    hub.subscribe(SID, T, listen().fn);
    target.mockResolvedValueOnce({ kind: "unavailable" }).mockRejectedValueOnce(new Error("redis"));
    upstreams[0]?.drop();
    await advance(0);
    // 1.5 s, then 3 s later: still nothing open.
    await advance(4_000);
    expect(upstreams).toHaveLength(1);
    await advance(1_000);
    expect(upstreams).toHaveLength(2);
  });

  it("a reconnect that finds another mailbox active ends as moved", async () => {
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    target.mockResolvedValueOnce({ kind: "ok", target: { ...T, username: "else@x.test" } });
    upstreams[0]?.drop();
    await advance(0);
    expect(a.events.at(-1)).toEqual({ type: "end", reason: "moved" });
  });

  it("checks the session every minute without refreshing, ending on sign-out or a switch", async () => {
    const { hub, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    await advance(60_000);
    expect(target).toHaveBeenLastCalledWith(SID, { connect: false });
    expect(a.events).toEqual([]);
    target.mockResolvedValueOnce({ kind: "unavailable" });
    await advance(60_000);
    expect(a.events).toEqual([]);
    target.mockRejectedValueOnce(new Error("redis"));
    await advance(60_000);
    expect(a.events).toEqual([]);
    target.mockResolvedValueOnce({ kind: "signedout" });
    await advance(60_000);
    expect(a.events).toEqual([{ type: "end", reason: "signedout" }]);

    const b = listen();
    hub.subscribe(SID, T, b.fn);
    target.mockResolvedValueOnce({ kind: "ok", target: { ...T, accountId: "q" } });
    await advance(60_000);
    expect(b.events).toEqual([{ type: "end", reason: "moved" }]);

    const c = listen();
    hub.subscribe(SID, T, c.fn);
    target.mockResolvedValueOnce({ kind: "moved" });
    await advance(60_000);
    expect(c.events).toEqual([{ type: "end", reason: "moved" }]);
  });

  it("opens the upstream again with a fresh token when the one it used expires", async () => {
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, { ...T, expiresAt: 120_000 }, a.fn);
    upstreams[0]?.open();
    target.mockResolvedValue({ kind: "ok", target: { ...T, accessToken: "tok-3", expiresAt: 999_999_999 } });
    await advance(119_000);
    expect(upstreams).toHaveLength(1);
    await advance(1_000);
    expect(upstreams[0]?.closed).toBe(true);
    expect(upstreams).toHaveLength(2);
    expect(upstreams[1]?.target.accessToken).toBe("tok-3");
    // Down until the new socket is up (the browser polls meanwhile), then ready (it catches up).
    expect(a.events.slice(1)).toEqual([{ type: "down" }]);
    upstreams[1]?.open();
    expect(a.events.at(-1)).toEqual({ type: "ready" });
    // A late event from the old socket is ignored.
    upstreams[0]?.push({ b: { Email: "late" } });
    expect(a.events.some((e) => e.type === "state")).toBe(false);
  });

  it("a reconnect asked for while a check is out runs when the check ends", async () => {
    let release: (r: PushTargetResult) => void = () => undefined;
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    upstreams[0]?.open();
    // The minute's check hangs on the session store...
    target.mockImplementationOnce(
      () =>
        new Promise<PushTargetResult>((resolve) => {
          release = resolve;
        }),
    );
    await advance(60_000);
    // ...while the upstream drops: its reconnect can't start yet.
    upstreams[0]?.drop();
    expect(a.events.at(-1)).toEqual({ type: "down" });
    await advance(0);
    expect(upstreams).toHaveLength(1);
    release({ kind: "ok", target: T });
    await settle();
    expect(upstreams).toHaveLength(2);
    upstreams[1]?.open();
    expect(a.events.at(-1)).toEqual({ type: "ready" });
  });

  it("the token-expiry reopen during a check isn't lost either", async () => {
    let release: (r: PushTargetResult) => void = () => undefined;
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, { ...T, expiresAt: 60_000 }, a.fn);
    upstreams[0]?.open();
    target.mockImplementationOnce(
      () =>
        new Promise<PushTargetResult>((resolve) => {
          release = resolve;
        }),
    );
    // Check and life timer both at 60 s: the check goes first and is out when the reopen comes.
    await advance(60_000);
    expect(upstreams[0]?.closed).toBe(true);
    expect(a.events.at(-1)).toEqual({ type: "down" });
    expect(upstreams).toHaveLength(1);
    release({ kind: "ok", target: T });
    await settle();
    expect(upstreams).toHaveLength(2);
  });

  it("a check that ends the channel drops the waiting reconnect", async () => {
    let release: (r: PushTargetResult) => void = () => undefined;
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    target.mockImplementationOnce(
      () =>
        new Promise<PushTargetResult>((resolve) => {
          release = resolve;
        }),
    );
    await advance(60_000);
    upstreams[0]?.drop();
    await advance(0);
    release({ kind: "signedout" });
    await settle();
    expect(upstreams).toHaveLength(1);
    expect(a.events.at(-1)).toEqual({ type: "end", reason: "signedout" });
  });

  it("caps an upstream's life at an hour and never below a minute", async () => {
    const { hub, upstreams, listen, advance } = setup();
    hub.subscribe(SID, { ...T, expiresAt: -5 }, listen().fn);
    await advance(59_999);
    expect(upstreams).toHaveLength(1);
    await advance(1);
    expect(upstreams).toHaveLength(2);
  });

  it("a revoked token found on reopening ends the streams (password changed)", async () => {
    const { hub, upstreams, listen, advance, target } = setup();
    const a = listen();
    hub.subscribe(SID, { ...T, expiresAt: 60_000 }, a.fn);
    upstreams[0]?.open();
    target.mockResolvedValue({ kind: "signedout" });
    await advance(60_000);
    expect(a.events.at(-1)).toEqual({ type: "end", reason: "signedout" });
  });

  it("closeSession ends only that session's channels", () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    const b = listen();
    hub.subscribe(SID, T, a.fn);
    hub.subscribe(SID2, T, b.fn);
    hub.closeSession(SID);
    expect(a.events).toEqual([{ type: "end", reason: "signedout" }]);
    expect(b.events).toEqual([]);
    expect(upstreams[0]?.closed).toBe(true);
    expect(upstreams[1]?.closed).toBe(false);
    hub.closeAll();
    expect(b.events).toEqual([{ type: "end", reason: "shutdown" }]);
    expect(hub.stats()).toEqual({ channels: 0, streams: 0, up: 0 });
  });

  it("closeSession after a password change ends the old id's channels as renewed", () => {
    const { hub, upstreams, listen } = setup();
    const a = listen();
    hub.subscribe(SID, T, a.fn);
    hub.closeSession(SID, "renewed");
    // The browser opens a stream for the new id; nothing of the old one (or its revoked token) stays open.
    expect(a.events).toEqual([{ type: "end", reason: "renewed" }]);
    expect(upstreams[0]?.closed).toBe(true);
    expect(hub.stats()).toEqual({ channels: 0, streams: 0, up: 0 });
  });

  it("a listener that throws doesn't stop the others", () => {
    const { hub, upstreams, listen } = setup();
    const ok = listen();
    hub.subscribe(SID, T, () => {
      throw new Error("closed");
    });
    hub.subscribe(SID, T, ok.fn);
    upstreams[0]?.open();
    expect(ok.events).toEqual([{ type: "ready" }]);
  });

  it("its stats carry no session id", () => {
    const { hub, listen } = setup();
    hub.subscribe(SID, T, listen().fn);
    expect(JSON.stringify(hub.stats())).not.toContain(SID);
    expect(hub.limits.channels).toBe(2);
  });
});
