// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import type { PushChannel, PushTimers, StateChange } from "@anhourmail/jmap-client/push";

/**
 * Webmail push fan-out (docs/internal/05-webmail.md "Push", ADR-0018): the BFF keeps **one upstream push channel per
 * signed-in session and mailbox** (the JMAP WebSocket, opened with that mailbox's token server-side) and passes each
 * `StateChange` for that mailbox's account on to the browser streams subscribed to it (`GET /api/webmail/push`). The
 * browser only ever learns which data types changed and their new state strings — the same values a changes
 * call returns — never a token, an id or content.
 *
 * Lifecycle:
 * - The channel opens with the first stream and closes `idleCloseMs` after the last one leaves (a page reload or a new
 *   leader tab picks it up again without a new upstream connection).
 * - It is checked every `checkMs` against the session (`target`, no token refresh): signed out, ended, blocked → every
 *   stream gets `end` ("signedout"); the session's active mailbox is another one now → `end` ("moved").
 * - The upstream connection lives at most until the token it was opened with expires; then it is opened again with a
 *   fresh token (`target` with `connect`, which refreshes). Stalwart keeps an open socket after a password change, so
 *   this is where a revoked token is noticed if nothing else noticed it first.
 * - A lost upstream is opened again with jittered backoff; streams get `down` (the browser polls meanwhile) and `ready`
 *   once it is back (the browser catches up with one changes request).
 * - Caps: `channels` per process and `streamsPerChannel`, `streams` in total. Over a cap, `subscribe` returns null and
 *   the route answers 503: the browser keeps polling (fail open).
 *
 * Process-wide: one hub per server process (`webmailPush()` keeps it on `globalThis`, so every route module — and a
 * dev reload — sees the same channels).
 */

/** What the browser is told on its stream. */
export type PushEvent =
  | { type: "ready" }
  | { type: "down" }
  | { type: "state"; changed: Partial<Record<PushType, string>> }
  | { type: "end"; reason: EndReason };

/**
 * Why a stream ended: the session ended, shows another mailbox now, the process is stopping, or the session moved to
 * a new id after its mailbox's own password change (the browser opens the stream again with the new cookie).
 */
export type EndReason = "signedout" | "moved" | "shutdown" | "renewed";

/** The data types passed on: what the webmail asks for changes of. */
export const PUSH_TYPES = ["Email", "Mailbox"] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export type PushListener = (e: PushEvent) => void;

/** The mailbox a channel is for, with the token to open it (held only while opening). */
export type PushTarget = { username: string; accountId: string; accessToken: string; expiresAt: number };

/** What the session says now: usable (with its active own mailbox), gone, on another mailbox, or not known now. */
export type PushTargetResult =
  { kind: "ok"; target: PushTarget } | { kind: "signedout" } | { kind: "moved" } | { kind: "unavailable" };

export type PushLimits = {
  /** Upstream channels per process. */
  channels: number;
  /** Browser streams per channel (normally one: tabs share it). */
  streamsPerChannel: number;
  /** Browser streams per process. */
  streams: number;
  /** How often an open channel checks its session. */
  checkMs: number;
  /** Backoff for opening a lost upstream again. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** How long a channel without streams stays open. */
  idleCloseMs: number;
  /** The longest an upstream connection lives before it is opened again with a fresh token. */
  maxUpstreamMs: number;
};

export const PUSH_LIMITS: PushLimits = {
  channels: 2_000,
  streamsPerChannel: 8,
  streams: 8_000,
  checkMs: 60_000,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 60_000,
  idleCloseMs: 30_000,
  maxUpstreamMs: 60 * 60_000,
};

export type PushHubDeps = {
  /** The session's active own mailbox now. `connect`: about to open the upstream (the token may be refreshed). */
  target: (sessionId: string, opts: { connect: boolean }) => Promise<PushTargetResult>;
  /** Opens the upstream push channel for `target`. */
  connect: (
    target: PushTarget,
    handlers: {
      onOpen: () => void;
      onStateChange: (change: StateChange) => void;
      onClose: (info: { code: number; opened: boolean }) => void;
    },
  ) => PushChannel;
  now?: () => number;
  timers?: PushTimers;
  random?: () => number;
  limits?: Partial<PushLimits>;
};

type Channel = {
  key: string;
  sessionKey: string;
  sessionId: string;
  username: string;
  accountId: string;
  listeners: Set<PushListener>;
  upstream: PushChannel | null;
  up: boolean;
  failures: number;
  /** A reconnect or a check is out: nothing else starts meanwhile. */
  busy: boolean;
  /** A reconnect was asked for while a check was out: it runs when the check ends. */
  pendingReconnect: boolean;
  ended: boolean;
  reconnectTimer: unknown;
  lifeTimer: unknown;
  idleTimer: unknown;
  checkTimer: unknown;
};

const defaultTimers: PushTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

/** Whether a channel has ended, read through a function: it can end while a check is out. */
const ended = (c: Channel): boolean => c.ended;

/** The session's key in the hub: a hash, so the hub's maps never hold a session id that would work as a cookie. */
const sessionKeyOf = (sessionId: string) => createHash("sha256").update(sessionId).digest("base64url");

export type PushSubscription = { unsubscribe(): void };

export class PushHub {
  readonly #d: Required<Omit<PushHubDeps, "limits">>;
  readonly #limits: PushLimits;
  readonly #channels = new Map<string, Channel>();
  #streams = 0;

  constructor(deps: PushHubDeps) {
    this.#d = {
      target: deps.target,
      connect: deps.connect,
      now: deps.now ?? Date.now,
      timers: deps.timers ?? defaultTimers,
      random: deps.random ?? Math.random,
    };
    this.#limits = { ...PUSH_LIMITS, ...deps.limits };
  }

  get limits(): PushLimits {
    return this.#limits;
  }

  /** Channels and streams open now (diagnostics and tests). */
  stats(): { channels: number; streams: number; up: number } {
    let up = 0;
    for (const c of this.#channels.values()) if (c.up) up += 1;
    return { channels: this.#channels.size, streams: this.#streams, up };
  }

  /**
   * Adds a browser stream for the session's mailbox `target` (just checked by the caller). Opens the upstream channel
   * if this is the first stream; tells `listener` `ready` at once if it is already up. Null when a cap is reached.
   */
  subscribe(sessionId: string, target: PushTarget, listener: PushListener): PushSubscription | null {
    const sessionKey = sessionKeyOf(sessionId);
    const key = `${sessionKey}\0${target.username}`;
    // One channel per session: a channel for another of its mailboxes is from before a switch.
    for (const c of [...this.#channels.values()]) {
      if (c.sessionKey === sessionKey && c.key !== key) this.#end(c, "moved");
    }
    if (this.#streams >= this.#limits.streams) return null;
    let ch = this.#channels.get(key);
    if (ch && ch.accountId !== target.accountId) {
      this.#end(ch, "moved");
      ch = undefined;
    }
    if (ch) {
      if (ch.listeners.size >= this.#limits.streamsPerChannel) return null;
    } else {
      if (this.#channels.size >= this.#limits.channels) return null;
      ch = {
        key,
        sessionKey,
        sessionId,
        username: target.username,
        accountId: target.accountId,
        listeners: new Set(),
        upstream: null,
        up: false,
        failures: 0,
        busy: false,
        pendingReconnect: false,
        ended: false,
        reconnectTimer: null,
        lifeTimer: null,
        idleTimer: null,
        checkTimer: null,
      };
      this.#channels.set(key, ch);
      const c = ch;
      c.checkTimer = this.#d.timers.setInterval(() => void this.#check(c), this.#limits.checkMs);
      this.#open(c, target);
    }
    if (ch.idleTimer !== null) {
      this.#d.timers.clearTimeout(ch.idleTimer);
      ch.idleTimer = null;
    }
    ch.listeners.add(listener);
    this.#streams += 1;
    if (ch.up) listener({ type: "ready" });
    const c = ch;
    let done = false;
    return {
      unsubscribe: () => {
        if (done) return;
        done = true;
        if (!c.listeners.delete(listener)) return;
        this.#streams -= 1;
        if (c.listeners.size === 0 && !c.ended) {
          c.idleTimer = this.#d.timers.setTimeout(() => {
            if (c.listeners.size === 0) this.#end(c, "shutdown");
          }, this.#limits.idleCloseMs);
        }
      },
    };
  }

  /**
   * Ends every channel of a session in this process: it signed out (its streams get `end` "signedout"), or it moved to
   * a new id after its own password change ("renewed": the old id is gone and the channel's token revoked, so the
   * browser opens a stream for the new id).
   */
  closeSession(sessionId: string, reason: "signedout" | "renewed" = "signedout"): void {
    const sessionKey = sessionKeyOf(sessionId);
    for (const c of [...this.#channels.values()]) if (c.sessionKey === sessionKey) this.#end(c, reason);
  }

  /** Ends everything (process shutting down). */
  closeAll(): void {
    for (const c of [...this.#channels.values()]) this.#end(c, "shutdown");
  }

  #emit(c: Channel, e: PushEvent): void {
    for (const l of [...c.listeners]) {
      try {
        l(e);
      } catch {
        // A stream that can't be written to is removed by its own close handling.
      }
    }
  }

  #open(c: Channel, target: PushTarget): void {
    if (c.ended) return;
    const lifetime = Math.max(60_000, Math.min(this.#limits.maxUpstreamMs, target.expiresAt - this.#d.now()));
    const current: PushChannel = this.#d.connect(target, {
      onOpen: () => {
        if (c.ended || c.upstream !== current) return;
        c.up = true;
        c.failures = 0;
        this.#emit(c, { type: "ready" });
      },
      onStateChange: (change) => {
        if (c.ended || c.upstream !== current) return;
        const mine = change[c.accountId];
        if (!mine) return;
        const changed: Partial<Record<PushType, string>> = {};
        for (const t of PUSH_TYPES) if (mine[t] !== undefined) changed[t] = mine[t];
        if (Object.keys(changed).length > 0) this.#emit(c, { type: "state", changed });
      },
      onClose: () => {
        if (c.ended || c.upstream !== current) return;
        this.#lost(c);
      },
    });
    c.upstream = current;
    if (c.lifeTimer !== null) this.#d.timers.clearTimeout(c.lifeTimer);
    // The token it opened with expires: open it again with a fresh one (and so notice a revoked one).
    c.lifeTimer = this.#d.timers.setTimeout(() => {
      if (c.ended || c.upstream !== current) return;
      c.lifeTimer = null;
      current.close();
      c.upstream = null;
      // Down until the new one is up: the browser polls meanwhile, and `ready` makes it catch up.
      const wasUp = c.up;
      c.up = false;
      if (wasUp) this.#emit(c, { type: "down" });
      void this.#reconnect(c);
    }, lifetime);
  }

  /** The upstream went away: streams poll until it is back. */
  #lost(c: Channel): void {
    c.upstream = null;
    const wasUp = c.up;
    c.up = false;
    if (wasUp) this.#emit(c, { type: "down" });
    const base = this.#limits.reconnectMinMs * 2 ** Math.min(c.failures, 16);
    const delay = c.failures === 0 ? 0 : Math.min(this.#limits.reconnectMaxMs, base) * (0.5 + this.#d.random() / 2);
    c.failures += 1;
    if (c.reconnectTimer !== null) this.#d.timers.clearTimeout(c.reconnectTimer);
    c.reconnectTimer = this.#d.timers.setTimeout(() => {
      c.reconnectTimer = null;
      void this.#reconnect(c);
    }, delay);
  }

  async #reconnect(c: Channel): Promise<void> {
    if (c.ended) return;
    if (c.busy) {
      // A check is out: reconnect as soon as it ends (never dropped, or the channel would stay down for good).
      c.pendingReconnect = true;
      return;
    }
    c.busy = true;
    let r: PushTargetResult;
    try {
      r = await this.#d.target(c.sessionId, { connect: true });
    } catch {
      r = { kind: "unavailable" };
    } finally {
      c.busy = false;
    }
    if (ended(c)) return;
    if (r.kind === "signedout" || r.kind === "moved") {
      this.#end(c, r.kind);
      return;
    }
    if (r.kind === "unavailable") {
      this.#lost(c);
      return;
    }
    if (r.target.username !== c.username || r.target.accountId !== c.accountId) {
      this.#end(c, "moved");
      return;
    }
    this.#open(c, r.target);
  }

  async #check(c: Channel): Promise<void> {
    if (c.ended || c.busy) return;
    c.busy = true;
    let r: PushTargetResult;
    try {
      r = await this.#d.target(c.sessionId, { connect: false });
    } catch {
      r = { kind: "unavailable" };
    } finally {
      c.busy = false;
    }
    if (ended(c)) return;
    if (r.kind === "signedout" || r.kind === "moved") this.#end(c, r.kind);
    else if (r.kind === "ok" && (r.target.username !== c.username || r.target.accountId !== c.accountId)) {
      this.#end(c, "moved");
    } else if (c.pendingReconnect) {
      c.pendingReconnect = false;
      void this.#reconnect(c);
    }
  }

  #end(c: Channel, reason: EndReason): void {
    if (c.ended) return;
    c.ended = true;
    this.#channels.delete(c.key);
    for (const t of [c.reconnectTimer, c.lifeTimer, c.idleTimer]) if (t !== null) this.#d.timers.clearTimeout(t);
    if (c.checkTimer !== null) this.#d.timers.clearInterval(c.checkTimer);
    c.upstream?.close();
    c.upstream = null;
    c.up = false;
    this.#emit(c, { type: "end", reason });
    this.#streams -= c.listeners.size;
    c.listeners.clear();
  }
}
