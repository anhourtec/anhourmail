// SPDX-License-Identifier: MIT
/**
 * JMAP push over WebSocket (RFC 8887 §4.3): one socket with the `jmap` subprotocol, push turned on with
 * `WebSocketPushEnable`, and `StateChange` objects read back. Server-side only: the socket carries the account's token
 * in its `Authorization` header (a WebSocket client that accepts headers, such as Node's built-in one). Only type and
 * state names are surfaced; nothing else in a message is kept or logged.
 */

/** Per account id, the data types that changed and their new state strings. */
export type StateChange = Record<string, Record<string, string>>;

/** The part of a WebSocket the channel uses. */
export type PushWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

/** A WebSocket constructor that takes request headers (Node's built-in WebSocket does, as an option). */
export type PushWebSocketCtor = new (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => PushWebSocket;

export type PushTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type PushChannelOptions = {
  /** The server's WebSocket URL, e.g. `ws://stalwart:8080/jmap/ws`. */
  url: string;
  /** Full Authorization header value. */
  authorization: string;
  /** Types to be told about (`null`: all). */
  dataTypes?: string[] | null;
  /**
   * How often to send `WebSocketPushEnable` again while nothing else is sent, so a server that ends quiet sockets
   * keeps this one (Stalwart's default idle timeout is 10 minutes). Default 4 minutes.
   */
  keepAliveMs?: number;
  /** How long the socket may take to open before it is given up. Default 10 s. */
  openTimeoutMs?: number;
  onOpen?: () => void;
  onStateChange: (change: StateChange) => void;
  /** Called once when the channel ends for any reason (never after `close()` was called by the owner). */
  onClose: (info: { code: number; opened: boolean }) => void;
  WebSocket?: PushWebSocketCtor;
  timers?: PushTimers;
};

export type PushChannel = {
  /** Ends the channel; `onClose` is not called. */
  close(): void;
  readonly open: boolean;
};

/** A type or state name as JMAP servers send them; anything longer or with other characters is dropped. */
const NAME = /^[A-Za-z0-9_:.-]{1,128}$/;

/**
 * Reads one WebSocket message: the `StateChange` it carries (well-formed entries only), or null when it is anything
 * else (a response, a malformed or oversized message).
 */
export function parseStateChange(data: unknown, maxBytes = 65_536): StateChange | null {
  if (typeof data !== "string" || data.length > maxBytes) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { "@type"?: unknown; changed?: unknown };
  if (m["@type"] !== "StateChange" || typeof m.changed !== "object" || m.changed === null) return null;
  const out: StateChange = {};
  for (const [account, types] of Object.entries(m.changed as Record<string, unknown>)) {
    if (!NAME.test(account) || typeof types !== "object" || types === null) continue;
    const entry: Record<string, string> = {};
    for (const [type, state] of Object.entries(types as Record<string, unknown>)) {
      if (NAME.test(type) && typeof state === "string" && NAME.test(state)) entry[type] = state;
    }
    if (Object.keys(entry).length > 0) out[account] = entry;
  }
  return out;
}

const defaultTimers: PushTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

const OPEN = 1;

/** Opens a push channel. Errors never throw: they end the channel through `onClose`. */
export function openPushChannel(opts: PushChannelOptions): PushChannel {
  const timers = opts.timers ?? defaultTimers;
  const Ctor = opts.WebSocket ?? (globalThis as unknown as { WebSocket: PushWebSocketCtor }).WebSocket;
  let ended = false;
  let opened = false;
  let socket: PushWebSocket | null = null;
  let keepAlive: unknown = null;
  let openTimer: unknown = null;

  const enable = JSON.stringify({ "@type": "WebSocketPushEnable", dataTypes: opts.dataTypes ?? null, pushState: null });

  const stop = () => {
    if (keepAlive !== null) timers.clearInterval(keepAlive);
    if (openTimer !== null) timers.clearTimeout(openTimer);
    keepAlive = null;
    openTimer = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000);
      } catch {
        // Already closing.
      }
    }
  };
  const finish = (code: number) => {
    if (ended) return;
    ended = true;
    stop();
    opts.onClose({ code, opened });
  };

  try {
    socket = new Ctor(opts.url, { protocols: ["jmap"], headers: { Authorization: opts.authorization } });
  } catch {
    // Reported asynchronously, like any other failure.
    timers.setTimeout(() => {
      finish(1006);
    }, 0);
    return {
      close: () => {
        ended = true;
      },
      get open() {
        return false;
      },
    };
  }
  const s = socket;
  openTimer = timers.setTimeout(() => {
    finish(1006);
  }, opts.openTimeoutMs ?? 10_000);
  s.onopen = () => {
    if (ended) return;
    if (openTimer !== null) timers.clearTimeout(openTimer);
    openTimer = null;
    try {
      s.send(enable);
    } catch {
      finish(1006);
      return;
    }
    opened = true;
    keepAlive = timers.setInterval(
      () => {
        if (s.readyState === OPEN) {
          try {
            s.send(enable);
          } catch {
            finish(1006);
          }
        }
      },
      opts.keepAliveMs ?? 4 * 60_000,
    );
    opts.onOpen?.();
  };
  s.onmessage = (ev) => {
    if (ended) return;
    const change = parseStateChange(ev.data);
    if (change && Object.keys(change).length > 0) opts.onStateChange(change);
  };
  s.onerror = () => {
    finish(1006);
  };
  s.onclose = (ev) => {
    finish(ev.code);
  };
  return {
    close: () => {
      if (ended) return;
      ended = true;
      stop();
    },
    get open() {
      return !ended && opened;
    },
  };
}
