// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { openPushChannel, parseStateChange, type PushTimers, type PushWebSocket } from "./push";

class FakeSocket implements PushWebSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  closed: number[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly init: { protocols: string[]; headers: Record<string, string> },
  ) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed.push(code);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

function manualTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number; every: boolean }>();
  const timers: PushTimers = {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms, every: false });
      return seq;
    },
    clearTimeout: (h) => pending.delete(h as number),
    setInterval: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms, every: true });
      return seq;
    },
    clearInterval: (h) => pending.delete(h as number),
  };
  /** Runs every timer waiting `ms` (intervals stay). */
  const fire = (ms: number) => {
    for (const [id, t] of [...pending]) {
      if (t.ms !== ms) continue;
      if (!t.every) pending.delete(id);
      t.fn();
    }
  };
  return { timers, fire, count: () => pending.size };
}

const open = (over: Partial<Parameters<typeof openPushChannel>[0]> = {}) => {
  const t = manualTimers();
  const onStateChange = vi.fn();
  const onClose = vi.fn();
  const onOpen = vi.fn();
  const ch = openPushChannel({
    url: "ws://mail/jmap/ws",
    authorization: "Bearer tok",
    dataTypes: ["Email", "Mailbox"],
    onStateChange,
    onClose,
    onOpen,
    WebSocket: FakeSocket,
    timers: t.timers,
    ...over,
  });
  const sock = FakeSocket.last;
  if (!sock) throw new Error("no socket");
  return { ch, sock, onStateChange, onClose, onOpen, ...t };
};

describe("parseStateChange", () => {
  it("reads type and state names per account", () => {
    expect(
      parseStateChange(JSON.stringify({ "@type": "StateChange", changed: { b: { Email: "sv2ca", Mailbox: "x1" } } })),
    ).toEqual({ b: { Email: "sv2ca", Mailbox: "x1" } });
  });

  it("drops anything that isn't a well-formed StateChange", () => {
    expect(parseStateChange("not json")).toBeNull();
    expect(parseStateChange(42)).toBeNull();
    expect(parseStateChange("null")).toBeNull();
    expect(parseStateChange(JSON.stringify({ "@type": "Response", methodResponses: [] }))).toBeNull();
    expect(parseStateChange(JSON.stringify({ "@type": "StateChange", changed: null }))).toBeNull();
    expect(parseStateChange("x".repeat(70_000))).toBeNull();
  });

  it("keeps only names of the expected shape", () => {
    const msg = {
      "@type": "StateChange",
      changed: {
        b: { Email: "ok", "bad type": "s", Mailbox: 5, Thread: "x".repeat(200), Sub: "has space" },
        "bad account": { Email: "s" },
        c: "nope",
        d: { Email: "<script>" },
      },
    };
    expect(parseStateChange(JSON.stringify(msg))).toEqual({ b: { Email: "ok" } });
  });
});

describe("openPushChannel", () => {
  it("opens with the jmap subprotocol and the token header, then enables push", () => {
    const { sock, onOpen, ch } = open();
    expect(sock.url).toBe("ws://mail/jmap/ws");
    expect(sock.init).toEqual({ protocols: ["jmap"], headers: { Authorization: "Bearer tok" } });
    expect(ch.open).toBe(false);
    sock.open();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(ch.open).toBe(true);
    expect(JSON.parse(sock.sent[0] ?? "")).toEqual({
      "@type": "WebSocketPushEnable",
      dataTypes: ["Email", "Mailbox"],
      pushState: null,
    });
  });

  it("passes state changes on and ignores other messages", () => {
    const { sock, onStateChange } = open();
    sock.open();
    sock.onmessage?.({ data: JSON.stringify({ "@type": "StateChange", changed: { b: { Email: "s2" } } }) });
    sock.onmessage?.({ data: JSON.stringify({ "@type": "StateChange", changed: {} }) });
    sock.onmessage?.({ data: "{" });
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith({ b: { Email: "s2" } });
  });

  it("sends the enable again as a keep-alive while open", () => {
    const { sock, fire } = open({ keepAliveMs: 1000 });
    sock.open();
    fire(1000);
    fire(1000);
    expect(sock.sent).toHaveLength(3);
    sock.readyState = 2;
    fire(1000);
    expect(sock.sent).toHaveLength(3);
  });

  it("reports the end once, with whether it had opened", () => {
    const { sock, onClose } = open();
    sock.open();
    sock.onclose?.({ code: 1006 });
    sock.onerror?.({});
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ code: 1006, opened: true });
  });

  it("gives up a socket that doesn't open in time", () => {
    const { onClose, sock, fire, count } = open({ openTimeoutMs: 500 });
    fire(500);
    expect(onClose).toHaveBeenCalledWith({ code: 1006, opened: false });
    expect(sock.closed).toEqual([1000]);
    expect(count()).toBe(0);
  });

  it("an error before opening ends it", () => {
    const { onClose, sock } = open();
    sock.onerror?.({});
    expect(onClose).toHaveBeenCalledWith({ code: 1006, opened: false });
  });

  it("closing by the owner stops timers and never reports", () => {
    const { ch, sock, onClose, onStateChange, count } = open();
    sock.open();
    ch.close();
    ch.close();
    expect(ch.open).toBe(false);
    expect(sock.closed).toEqual([1000]);
    expect(count()).toBe(0);
    sock.onclose?.({ code: 1000 });
    sock.onmessage?.({ data: JSON.stringify({ "@type": "StateChange", changed: { b: { Email: "s" } } }) });
    expect(onClose).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("a send failing on open ends the channel", () => {
    const { sock, onClose, onOpen } = open();
    sock.send = () => {
      throw new Error("gone");
    };
    sock.open();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith({ code: 1006, opened: false });
  });

  it("a keep-alive send failing ends the channel", () => {
    const { sock, onClose, fire } = open({ keepAliveMs: 7 });
    sock.open();
    sock.send = () => {
      throw new Error("gone");
    };
    fire(7);
    expect(onClose).toHaveBeenCalledWith({ code: 1006, opened: true });
  });

  it("a constructor that throws is reported asynchronously", () => {
    const t = manualTimers();
    const onClose = vi.fn();
    const Throwing = function () {
      throw new Error("bad url");
    } as unknown as typeof FakeSocket;
    const ch = openPushChannel({
      url: "x",
      authorization: "a",
      onStateChange: () => undefined,
      onClose,
      WebSocket: Throwing,
      timers: t.timers,
    });
    expect(ch.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    t.fire(0);
    expect(onClose).toHaveBeenCalledWith({ code: 1006, opened: false });
    ch.close();
  });
});
