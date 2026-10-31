// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import type { KeyRing } from "@anhourmail/server/keyring";

import { addTiming, timed } from "../http/server-timing";
import { pinnedAddress, pinView, unpinWrite } from "./pin";

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
  /**
   * Set when this is another person's mailbox opened through a delegation grant (ADR-0026 §6): the tokens are that
   * mailbox's own, and every use is checked against the grant first (`DelegationGate`). Absent for the session's own
   * signed-in mailboxes.
   */
  delegated?: {
    mailboxId: string;
    /** The delegate (console user id). */
    granteeUserId: string;
    /** The delegate's own signed-in mailbox the grant comes through (lowercase). */
    via: string;
    /**
     * What it was opened (or last re-checked) for: `full_access` (read and manage, or a mailbox-scoped tab) or `send`
     * (minted by a send). Only a `full_access` entry can be pinned to a tab (`pin.ts`); absent on older records.
     */
    opened?: "full_access" | "send";
  };
};

/**
 * A webmail session: the active mailbox at the top level (what every request uses) plus any other mailboxes
 * signed in to the same session ("Add another mailbox"), each with its own tokens, all sealed together.
 */
export type WebmailSession = MailboxTokens & {
  /** Sign-in time, epoch ms. */
  createdAt: number;
  /**
   * Set when the console handoff opened this session (ADR-0024): the console session it came from. When that console
   * session ends (sign-out, "sign out everywhere", a revoke, a password reset), this webmail session ends too.
   */
  console?: { userId: string; sessionId: string };
  /**
   * Other signed-in mailboxes (not active): at most `MAX_MAILBOXES - 1` of the session's own, plus at most
   * `DELEGATED_MAILBOXES_PER_PERSON` delegated ones (`delegated` set).
   */
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

/**
 * One request's copies of the session records it has read (`withSessionReads`): the gates and the handler read the
 * same record several times per request, and each read is a Redis round trip plus a decrypt. A copy is used only
 * while no write of any session has happened in this process since it was read (any write, compare-and-set, delete
 * — a refresh another request finished, a switch), for at most `READ_COPY_MS`, and never once the request has
 * answered (deferred work the request scheduled reads afresh). Every reader gets its own clone.
 */
type ReadCopies = { open: boolean; copies: Map<string, { at: number; writes: number; data: WebmailSession }> };
const readScope = new AsyncLocalStorage<ReadCopies>();
const READ_COPY_MS = 2_000;

/**
 * Runs `fn` (one webmail API request) with its session reads shared (`route()`); the copies end when `fn` settles.
 */
export async function withSessionReads<T>(fn: () => Promise<T>): Promise<T> {
  const scope: ReadCopies = { open: true, copies: new Map() };
  try {
    return await readScope.run(scope, fn);
  } finally {
    scope.open = false;
    scope.copies.clear();
  }
}

const PURPOSE = "webmail-session";
const VIEW_KEY_PURPOSE = "webmail-view-key";
/** Where a session's view key lives, next to its record. */
const viewKeyKey = (sessionKey: string) => sessionKey.replace("am:wm:s:", "am:wm:vk:");
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export const isSessionId = (v: string): boolean => SESSION_ID.test(v);

export class WebmailSessionStore {
  readonly #kv: SessionKv;
  readonly #ring: KeyRing;
  readonly #idleTtlSec: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  /** Writes of any session record made through this store (process-wide): a request's read copies older are stale. */
  #writes = 0;

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
    this.#writes += 1;
    if (ttl > 0) await timed("kv", () => this.#kv.set(key, this.#seal(key, { ...data, version: 1 }), ttl, "create"));
    return sessionId;
  }

  /**
   * Updates a session read earlier: only if nobody wrote it since (`data.version`), and only while it exists — a
   * refresh finishing after sign-out or after a mailbox switch writes nothing and gets false.
   */
  async write(sessionId: string, written: WebmailSession): Promise<boolean> {
    const key = this.#key(sessionId);
    let data = written;
    this.#writes += 1;
    if (pinnedAddress() !== null) {
      // A request pinned to a shared mailbox (a mailbox-scoped tab) writes the session's real active mailbox back. It
      // is taken from the record this write replaces (the same version, or the compare-and-set below fails anyway),
      // never from what another read in this request saw.
      const stored = await this.#readRaw(key, false);
      if (!stored || (stored.version ?? 0) !== (written.version ?? 0)) return false;
      data = unpinWrite(written, stored);
    }
    const ttl = this.#ttl(data);
    if (ttl <= 0) {
      await this.#drop(key);
      return false;
    }
    const current = data.version ?? 0;
    const sealed = this.#seal(key, { ...data, version: current + 1 });
    try {
      return await timed("kv", () => this.#kv.cas(key, String(current), sealed, ttl));
    } finally {
      // Whether it landed or lost to another write, what this request read before is no longer the record.
      this.#writes += 1;
    }
  }

  #ttl(data: WebmailSession): number {
    const remainingSec = Math.floor((data.createdAt + this.#maxAgeMs - this.#now()) / 1000);
    return Math.min(this.#idleTtlSec, remainingSec);
  }

  /** `<version>.<sealed JSON>`: the version is readable for compare-and-set; everything else is sealed. */
  #seal(key: string, data: WebmailSession): string {
    return `${String(data.version ?? 0)}.${this.#ring.encrypt(PURPOSE, JSON.stringify(data), key)}`;
  }

  /**
   * The session, or null when unknown, expired, tampered with or sealed under a retired key. In a request pinned to a
   * shared mailbox (`pin.ts`), that mailbox is the active entry of what is returned (`PinnedMailboxMissingError` when it
   * isn't open in this session).
   */
  async read(sessionId: string): Promise<WebmailSession | null> {
    if (!isSessionId(sessionId)) return null;
    const data = await this.#readRaw(this.#key(sessionId));
    return data ? pinView(data) : null;
  }

  /**
   * The stored record as it is (no pin applied), or null; drops one that is expired or can't be opened. Inside
   * `withSessionReads`, a copy this request read earlier is reused while no session was written since (`shared`).
   */
  async #readRaw(key: string, shared = true): Promise<WebmailSession | null> {
    const scope = shared ? readScope.getStore() : undefined;
    const now = this.#now();
    if (scope?.open) {
      const copy = scope.copies.get(key);
      if (copy?.writes === this.#writes && now - copy.at < READ_COPY_MS && copy.data.createdAt + this.#maxAgeMs > now) {
        addTiming("kvhit", 0);
        return structuredClone(copy.data);
      }
    }
    const writes = this.#writes;
    const data = await this.#readStored(key);
    if (scope?.open) {
      if (data && writes === this.#writes) scope.copies.set(key, { at: now, writes, data: structuredClone(data) });
      else scope.copies.delete(key);
    }
    return data;
  }

  async #readStored(key: string): Promise<WebmailSession | null> {
    const stored = await timed("kv", () => this.#kv.get(key));
    if (stored === null) return null;
    const m = /^(\d{1,15})\.(.*)$/s.exec(stored);
    let data: WebmailSession;
    try {
      data = JSON.parse(this.#ring.decrypt(PURPOSE, m?.[2] ?? stored, key)) as WebmailSession;
      data.version = m ? Number(m[1]) : 0;
    } catch {
      await this.#drop(key);
      return null;
    }
    if (data.createdAt + this.#maxAgeMs <= this.#now()) {
      await this.#drop(key);
      return null;
    }
    return data;
  }

  /**
   * Deletes a session record and its view key. The write count moves before and after the delete, so no read copy
   * taken while it was in flight outlives it.
   */
  async #drop(key: string): Promise<void> {
    this.#writes += 1;
    try {
      await this.#kv.del(key);
      await this.#kv.del(viewKeyKey(key));
    } finally {
      this.#writes += 1;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    if (!isSessionId(sessionId)) return;
    await this.#drop(this.#key(sessionId));
  }

  /**
   * This session's key for the browser's encrypted copy of the first view (`components/webmail/view-cache.ts`): 32
   * random bytes, base64url, made on first use and kept sealed in Redis next to the session record (same lifetime,
   * deleted with it). Handed only to the webmail page of a checked session, never stored in the browser: once the
   * session ends, what the browser kept can't be read. Null when the session doesn't exist.
   */
  async viewKey(sessionId: string): Promise<string | null> {
    if (!isSessionId(sessionId)) return null;
    const key = this.#key(sessionId);
    const s = await this.#readRaw(key);
    if (!s) return null;
    const at = viewKeyKey(key);
    const open = (sealed: string | null): string | null => {
      if (sealed === null) return null;
      try {
        return this.#ring.decrypt(VIEW_KEY_PURPOSE, sealed, at);
      } catch {
        return null;
      }
    };
    const found = open(await timed("kv", () => this.#kv.get(at)));
    if (found) return found;
    const ttl = this.#ttl(s);
    if (ttl <= 0) return null;
    const fresh = randomBytes(32).toString("base64url");
    await timed("kv", () => this.#kv.set(at, this.#ring.encrypt(VIEW_KEY_PURPOSE, fresh, at), ttl, "create"));
    // Two first uses at once: whichever was stored last is the key (the other's copy just isn't readable).
    return open(await timed("kv", () => this.#kv.get(at))) ?? fresh;
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
