// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";

import type { KeyRing } from "@anhourmail/server/keyring";

/**
 * Webmail sessions (ADR-0003, ADR-0018, CLAUDE.md rule 16). The browser holds only an opaque random id in an
 * HttpOnly cookie. Redis holds, under a hash of that id, the user's Stalwart access and refresh tokens sealed with
 * the key ring (AES-256-GCM, AAD = the hashed key), so a Redis dump alone yields neither cookies nor tokens.
 * Sessions expire after `idleTtlSec` without use and `maxAgeMs` after sign-in, whichever comes first.
 */

/** One signed-in mailbox: its address, JMAP account and Stalwart tokens. */
export type MailboxTokens = {
  /** The mailbox address (JMAP `username`). */
  username: string;
  /** The JMAP mail account id. */
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Access token expiry, epoch ms. */
  expiresAt: number;
};

/**
 * A webmail session: the active mailbox at the top level (what every request uses) plus any other mailboxes
 * signed in to the same session ("Add another mailbox"), each with its own tokens, all sealed together.
 */
export type WebmailSession = MailboxTokens & {
  /** Sign-in time, epoch ms. */
  createdAt: number;
  /** Other signed-in mailboxes (not active). At most `MAX_MAILBOXES - 1`. */
  others?: MailboxTokens[];
  /**
   * Write version (compare-and-set): a write succeeds only if the stored version is still the one this copy was
   * read at, so a refresh finishing late can't undo a mailbox switch made meanwhile. Set by the store.
   */
  version?: number | undefined;
};

/** Mailboxes one webmail session may hold. */
export const MAX_MAILBOXES = 5;

/** Minimal key-value port (Redis in the app, a Map in tests). */
export type SessionKv = {
  get(key: string): Promise<string | null>;
  /** Stores a new value (a new session). */
  set(key: string, value: string, ttlSec: number, mode: "create" | "update"): Promise<boolean>;
  /**
   * Compare-and-set: writes `value` only if the key exists and its stored version (the digits before the first
   * ".") is `expected` — atomically (a Lua script in Redis). A signed-out session or a concurrent write → false.
   */
  cas(key: string, expected: string, value: string, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
};

const PURPOSE = "webmail-session";
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export const isSessionId = (v: string): boolean => SESSION_ID.test(v);

export class WebmailSessionStore {
  readonly #kv: SessionKv;
  readonly #ring: KeyRing;
  readonly #idleTtlSec: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(kv: SessionKv, ring: KeyRing, opts: { idleTtlSec?: number; maxAgeMs?: number; now?: () => number } = {}) {
    this.#kv = kv;
    this.#ring = ring;
    this.#idleTtlSec = opts.idleTtlSec ?? 7 * 86_400;
    this.#maxAgeMs = opts.maxAgeMs ?? 30 * 86_400_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Seconds a cookie should live: the absolute session lifetime. */
  get cookieMaxAgeSec(): number {
    return Math.floor(this.#maxAgeMs / 1000);
  }

  #key(sessionId: string): string {
    return `am:wm:s:${createHash("sha256").update(sessionId).digest("base64url")}`;
  }

  async create(data: WebmailSession): Promise<string> {
    const sessionId = randomBytes(32).toString("base64url");
    const key = this.#key(sessionId);
    const ttl = this.#ttl(data);
    if (ttl > 0) await this.#kv.set(key, this.#seal(key, { ...data, version: 1 }), ttl, "create");
    return sessionId;
  }

  /**
   * Updates a session read earlier: only if nobody wrote it since (`data.version`), and only while it exists — a
   * refresh finishing after sign-out or after a mailbox switch writes nothing and gets false.
   */
  async write(sessionId: string, data: WebmailSession): Promise<boolean> {
    const key = this.#key(sessionId);
    const ttl = this.#ttl(data);
    if (ttl <= 0) {
      await this.#kv.del(key);
      return false;
    }
    const current = data.version ?? 0;
    return this.#kv.cas(key, String(current), this.#seal(key, { ...data, version: current + 1 }), ttl);
  }

  #ttl(data: WebmailSession): number {
    const remainingSec = Math.floor((data.createdAt + this.#maxAgeMs - this.#now()) / 1000);
    return Math.min(this.#idleTtlSec, remainingSec);
  }

  /** `<version>.<sealed JSON>`: the version is readable for compare-and-set; everything else is sealed. */
  #seal(key: string, data: WebmailSession): string {
    return `${String(data.version ?? 0)}.${this.#ring.encrypt(PURPOSE, JSON.stringify(data), key)}`;
  }

  /** The session, or null when unknown, expired, tampered with or sealed under a retired key. */
  async read(sessionId: string): Promise<WebmailSession | null> {
    if (!isSessionId(sessionId)) return null;
    const key = this.#key(sessionId);
    const stored = await this.#kv.get(key);
    if (stored === null) return null;
    const m = /^(\d{1,15})\.(.*)$/s.exec(stored);
    let data: WebmailSession;
    try {
      data = JSON.parse(this.#ring.decrypt(PURPOSE, m?.[2] ?? stored, key)) as WebmailSession;
      data.version = m ? Number(m[1]) : 0;
    } catch {
      await this.#kv.del(key);
      return null;
    }
    if (data.createdAt + this.#maxAgeMs <= this.#now()) {
      await this.#kv.del(key);
      return null;
    }
    return data;
  }

  async destroy(sessionId: string): Promise<void> {
    if (isSessionId(sessionId)) await this.#kv.del(this.#key(sessionId));
  }
}

/** In-memory KV for tests (TTL honoured against `now`). */
export function memoryKv(now: () => number = Date.now): SessionKv & { size(): number; raw(): Map<string, string> } {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp <= now()) {
        m.delete(k);
        return null;
      }
      return e.v;
    },
    async set(k, v, ttl, mode) {
      const live = m.get(k);
      if (mode === "update" && (!live || live.exp <= now())) return false;
      m.set(k, { v, exp: now() + ttl * 1000 });
      return true;
    },
    async cas(k, expected, v, ttl) {
      const live = m.get(k);
      if (!live || live.exp <= now()) return false;
      if ((/^(\d{1,15})\./.exec(live.v)?.[1] ?? "0") !== expected) return false;
      m.set(k, { v, exp: now() + ttl * 1000 });
      return true;
    },
    async del(k) {
      m.delete(k);
    },
    size: () => m.size,
    raw: () => new Map([...m].map(([k, e]) => [k, e.v])),
  };
}
