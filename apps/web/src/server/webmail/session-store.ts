// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";

import type { KeyRing } from "@anhourmail/server/keyring";

/**
 * Webmail sessions (ADR-0003, ADR-0018, CLAUDE.md rule 16). The browser holds only an opaque random id in an
 * HttpOnly cookie. Redis holds, under a hash of that id, the user's Stalwart access and refresh tokens sealed with
 * the key ring (AES-256-GCM, AAD = the hashed key), so a Redis dump alone yields neither cookies nor tokens.
 * Sessions expire after `idleTtlSec` without use and `maxAgeMs` after sign-in, whichever comes first.
 */

export type WebmailSession = {
  /** The mailbox address (JMAP `username`). */
  username: string;
  /** The JMAP mail account id. */
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Access token expiry, epoch ms. */
  expiresAt: number;
  /** Sign-in time, epoch ms. */
  createdAt: number;
};

/** Minimal key-value port (Redis in the app, a Map in tests). */
export type SessionKv = {
  get(key: string): Promise<string | null>;
  /**
   * Stores `value`. `"update"` writes only if the key still exists (Redis `SET … XX`) and reports whether it did, so
   * a refresh that finishes after sign-out can't bring the session back.
   */
  set(key: string, value: string, ttlSec: number, mode: "create" | "update"): Promise<boolean>;
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
    await this.#put(sessionId, data, "create");
    return sessionId;
  }

  /** Updates an existing session; false (and nothing written) when it was signed out or expired meanwhile. */
  async write(sessionId: string, data: WebmailSession): Promise<boolean> {
    return this.#put(sessionId, data, "update");
  }

  async #put(sessionId: string, data: WebmailSession, mode: "create" | "update"): Promise<boolean> {
    const key = this.#key(sessionId);
    const remainingSec = Math.floor((data.createdAt + this.#maxAgeMs - this.#now()) / 1000);
    const ttl = Math.min(this.#idleTtlSec, remainingSec);
    if (ttl <= 0) {
      await this.#kv.del(key);
      return false;
    }
    return this.#kv.set(key, this.#ring.encrypt(PURPOSE, JSON.stringify(data), key), ttl, mode);
  }

  /** The session, or null when unknown, expired, tampered with or sealed under a retired key. */
  async read(sessionId: string): Promise<WebmailSession | null> {
    if (!isSessionId(sessionId)) return null;
    const key = this.#key(sessionId);
    const sealed = await this.#kv.get(key);
    if (sealed === null) return null;
    let data: WebmailSession;
    try {
      data = JSON.parse(this.#ring.decrypt(PURPOSE, sealed, key)) as WebmailSession;
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
    async del(k) {
      m.delete(k);
    },
    size: () => m.size,
    raw: () => new Map([...m].map(([k, e]) => [k, e.v])),
  };
}
