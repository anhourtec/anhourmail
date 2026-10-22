// SPDX-License-Identifier: AGPL-3.0-only
import { log } from "@anhourmail/server/log";

import { isLimitError, type JmapRequestBody } from "./jmap-policy";
import { QueueFullError, UserQueue, withLimitRetry } from "./queue";
import type { WebmailSession, WebmailSessionStore } from "./session-store";
import {
  BODY_PROPERTIES,
  buildMessageView,
  EMAIL_PROPERTIES,
  inlineImageParts,
  type JmapEmail,
  MAX_BODY_BYTES,
  type MessageView,
} from "./view";

/**
 * The webmail BFF (ADR-0003, ADR-0018): signs people in with their mailbox password through Stalwart's OAuth
 * code flow, keeps their tokens server-side, refreshes them, and forwards allow-listed JMAP calls through a
 * per-user queue. Never logs request or response bodies, addresses or subjects (CLAUDE.md rule 24).
 */

/** Signed out: no session, or Stalwart revoked the tokens (e.g. after a password change). → 401 */
export class WebmailSignedOutError extends Error {
  override readonly name = "WebmailSignedOutError";
}
/** Wrong address or password (deliberately not saying which). → 401 */
export class WebmailSignInError extends Error {
  override readonly name = "WebmailSignInError";
}
/** Stalwart unreachable or misbehaving. → 503 */
export class WebmailUnavailableError extends Error {
  override readonly name = "WebmailUnavailableError";
}
/**
 * The mailbox is suspended, being deleted or gone from the control plane: the session is ended even though
 * Stalwart may still accept its tokens. → 401 with its own message
 */
export class WebmailBlockedError extends Error {
  override readonly name = "WebmailBlockedError";
}
/** Too much queued for this person, or Stalwart kept refusing on concurrency. → 429 */
export class WebmailBusyError extends Error {
  override readonly name = "WebmailBusyError";
}

/** The OAuth port refused the credentials or the grant (wrong password, revoked refresh token). */
export class GrantRefusedError extends Error {
  override readonly name = "GrantRefusedError";
}

export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: number };

/** Stalwart's OAuth server, behind an adapter (apps/web/src/server/adapters/stalwart-oauth.ts). */
export type OAuthPort = {
  signIn(accountName: string, accountSecret: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
};

export type WebmailDeps = {
  store: WebmailSessionStore;
  oauth: OAuthPort;
  /** Stalwart's HTTP base URL (internal network). */
  stalwartUrl: string;
  /** Control-plane gate: may this mailbox use the webmail now? (core `MailboxAccessGate`, cached ≤ 30 s) */
  access: { allowed(address: string): Promise<boolean> };
  fetch?: typeof fetch;
  queue?: UserQueue;
  now?: () => number;
  /** Refresh when the access token has less than this left (ms). */
  refreshSkewMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const MAIL = "urn:ietf:params:jmap:mail";
const USING = ["urn:ietf:params:jmap:core", MAIL];
/** Inline images we embed as data: URIs: per image and per message. */
const MAX_INLINE_IMAGE = 512 * 1024;
const MAX_INLINE_TOTAL = 2 * 1024 * 1024;

export class WebmailService {
  readonly #d: Required<Omit<WebmailDeps, "sleep">> & { sleep?: (ms: number) => Promise<void> };
  readonly #base: string;
  /** One refresh at a time per session (several tabs or calls may notice expiry together). */
  readonly #refreshing = new Map<string, Promise<WebmailSession | null>>();

  constructor(deps: WebmailDeps) {
    this.#d = {
      fetch: fetch,
      queue: new UserQueue(),
      now: Date.now,
      refreshSkewMs: 60_000,
      ...deps,
    };
    this.#base = deps.stalwartUrl.replace(/\/+$/, "");
  }

  get store(): WebmailSessionStore {
    return this.#d.store;
  }

  /** Signs in with the mailbox address and password (used once here, never stored or logged). */
  async signIn(address: string, password: string): Promise<{ sessionId: string; session: WebmailSession }> {
    let tokens: OAuthTokens;
    try {
      tokens = await this.#d.oauth.signIn(address, password);
    } catch (err) {
      if (err instanceof GrantRefusedError) throw new WebmailSignInError("sign-in refused");
      // Stalwart throttling or banning: "busy", never "wrong password".
      if (err instanceof WebmailBusyError) throw err;
      log.warn("webmail sign-in: Stalwart unavailable", { component: "webmail", err });
      throw new WebmailUnavailableError("mail server unavailable");
    }
    const res = await this.#upstream(`${this.#base}/jmap/session`, { headers: this.#auth(tokens.accessToken) });
    if (!res.ok) {
      log.warn("webmail sign-in: session fetch failed", { component: "webmail", status: res.status });
      throw new WebmailUnavailableError("mail server unavailable");
    }
    const s = (await res.json()) as { username?: unknown; primaryAccounts?: Record<string, unknown> };
    const accountId = s.primaryAccounts?.[MAIL];
    if (typeof accountId !== "string" || typeof s.username !== "string") {
      throw new WebmailUnavailableError("mail account missing from session");
    }
    // Password proven; now the control plane decides (a suspended mailbox may still hold valid credentials).
    if (!(await this.#d.access.allowed(s.username))) throw new WebmailBlockedError("mailbox unavailable");
    const session: WebmailSession = {
      username: s.username,
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      createdAt: this.#d.now(),
    };
    const sessionId = await this.#d.store.create(session);
    return { sessionId, session };
  }

  async signOut(sessionId: string): Promise<void> {
    // Stalwart v0.16 has no token revocation endpoint: dropping our only copy ends the session; the access token
    // lapses within the hour.
    this.#refreshing.delete(sessionId);
    await this.#d.store.destroy(sessionId);
  }

  /**
   * A usable session (refreshed when close to expiry), or null when signed out. Every use re-checks the control
   * plane: a suspended or deleted mailbox ends the session (`WebmailBlockedError`).
   */
  async session(sessionId: string, opts: { forceRefresh?: boolean } = {}): Promise<WebmailSession | null> {
    const s = await this.#d.store.read(sessionId);
    if (!s) return null;
    if (!(await this.#d.access.allowed(s.username))) {
      this.#refreshing.delete(sessionId);
      await this.#d.store.destroy(sessionId);
      throw new WebmailBlockedError("mailbox unavailable");
    }
    if (!opts.forceRefresh && s.expiresAt - this.#d.now() > this.#d.refreshSkewMs) return s;
    const pending = this.#refreshing.get(sessionId);
    if (pending) return pending;
    const p = this.#refresh(sessionId, s).finally(() => this.#refreshing.delete(sessionId));
    this.#refreshing.set(sessionId, p);
    return p;
  }

  async #refresh(sessionId: string, s: WebmailSession): Promise<WebmailSession | null> {
    if (!s.refreshToken) {
      await this.#d.store.destroy(sessionId);
      return null;
    }
    try {
      const t = await this.#d.oauth.refresh(s.refreshToken);
      const next: WebmailSession = {
        ...s,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
      // Signed out while the refresh was in flight: don't bring the session back.
      if (!(await this.#d.store.write(sessionId, next))) return null;
      return next;
    } catch (err) {
      if (err instanceof GrantRefusedError) {
        await this.#d.store.destroy(sessionId);
        return null;
      }
      // Still valid for a little while? Keep using it rather than failing the request.
      if (s.expiresAt > this.#d.now()) return s;
      log.warn("webmail token refresh failed", { component: "webmail", err });
      throw new WebmailUnavailableError("mail server unavailable");
    }
  }

  #auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  async #upstream(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#d.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      log.warn("webmail upstream unreachable", { component: "webmail", err });
      throw new WebmailUnavailableError("mail server unavailable");
    }
  }

  /**
   * Runs `call` with a fresh token through the user's queue, retrying JMAP `limit` errors, and once more with a
   * refreshed token on 401. Throws `WebmailSignedOutError` when the session is gone or revoked.
   */
  async #withSession<T>(
    sessionId: string,
    call: (s: WebmailSession) => Promise<{ status: number; limited: boolean; value: T }>,
  ): Promise<{ session: WebmailSession; value: T }> {
    let s = await this.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = s;
      let result: { status: number; value: T } | null;
      try {
        result = await this.#d.queue.run(current.username, () =>
          withLimitRetry(
            async () => {
              const r = await call(current);
              return r.limited ? { retry: true as const } : { retry: false as const, value: r };
            },
            this.#d.sleep ? { sleep: this.#d.sleep } : {},
          ),
        );
      } catch (err) {
        if (err instanceof QueueFullError) throw new WebmailBusyError("busy");
        throw err;
      }
      if (result === null) throw new WebmailBusyError("busy");
      if (result.status === 403) {
        // Stalwart refuses tokens of a suspended account with 403 (verified on v0.16.27): end the session.
        await this.#d.store.destroy(sessionId);
        throw new WebmailBlockedError("mailbox unavailable");
      }
      if (result.status !== 401) return { session: current, value: result.value };
      if (attempt === 1) break;
      const refreshed = await this.session(sessionId, { forceRefresh: true });
      if (!refreshed) throw new WebmailSignedOutError("signed out");
      s = refreshed;
    }
    await this.#d.store.destroy(sessionId);
    throw new WebmailSignedOutError("signed out");
  }

  /** Forwards an allow-listed JMAP request (already checked by `checkJmapRequest`). */
  async jmap(sessionId: string, body: JmapRequestBody): Promise<{ status: number; body: unknown }> {
    const { value } = await this.#withSession(sessionId, async (s) => {
      const res = await this.#upstream(`${this.#base}/jmap/`, {
        method: "POST",
        headers: { ...this.#auth(s.accessToken), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      return { status: res.status, limited: isLimitError(res.status, json), value: { status: res.status, body: json } };
    });
    if (value.status >= 500) {
      log.warn("webmail upstream error", { component: "webmail", status: value.status });
      throw new WebmailUnavailableError("mail server error");
    }
    return value;
  }

  /** One message, sanitised for the reader. Null when the id is not in this mailbox. */
  async message(
    sessionId: string,
    emailId: string,
    sanitize: (
      html: string,
      inline: ReadonlyMap<string, string>,
    ) => {
      html: string;
      blockedImages: number;
      blockedTrackers: number;
    },
  ): Promise<MessageView | null> {
    let accountId = "";
    const res = await this.jmapAs(sessionId, (s) => {
      accountId = s.accountId;
      return {
        using: USING,
        methodCalls: [
          [
            "Email/get",
            {
              accountId: s.accountId,
              ids: [emailId],
              properties: EMAIL_PROPERTIES,
              bodyProperties: BODY_PROPERTIES,
              fetchHTMLBodyValues: true,
              fetchTextBodyValues: true,
              maxBodyValueBytes: MAX_BODY_BYTES,
            },
            "m",
          ],
        ],
      };
    });
    const resp = res as { methodResponses?: [string, { list?: JmapEmail[] }, string][] } | null;
    const [name, args] = resp?.methodResponses?.[0] ?? [];
    if (name !== "Email/get") throw new WebmailUnavailableError("unexpected response");
    const email = args?.list?.[0];
    if (!email) return null;

    // Inline images referenced by cid: become data: URIs (bounded), never URLs the frame could fetch.
    const inline = new Map<string, string>();
    let total = 0;
    for (const part of inlineImageParts(email)) {
      if (part.size > MAX_INLINE_IMAGE || total + part.size > MAX_INLINE_TOTAL || !part.blobId) continue;
      const blob = await this.download(sessionId, accountId, part.blobId, "inline");
      if (!blob.ok) continue;
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.length > MAX_INLINE_IMAGE) continue;
      total += bytes.length;
      inline.set(
        (part.cid ?? "").replace(/^<|>$/g, ""),
        `data:${part.type.toLowerCase()};base64,${bytes.toString("base64")}`,
      );
    }
    return buildMessageView(email, (html) => sanitize(html, inline));
  }

  /** Server-built JMAP request for the signed-in account (no allow-list: the BFF wrote it). */
  async jmapAs(sessionId: string, build: (s: WebmailSession) => JmapRequestBody): Promise<unknown> {
    const { value } = await this.#withSession(sessionId, async (s) => {
      const res = await this.#upstream(`${this.#base}/jmap/`, {
        method: "POST",
        headers: { ...this.#auth(s.accessToken), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(build(s)),
      });
      const json: unknown = await res.json().catch(() => null);
      return { status: res.status, limited: isLimitError(res.status, json), value: { status: res.status, body: json } };
    });
    if (value.status !== 200) {
      log.warn("webmail upstream error", { component: "webmail", status: value.status });
      throw new WebmailUnavailableError("mail server error");
    }
    return value.body;
  }

  /**
   * Streams a blob of the signed-in account (`accountId` must be theirs: the caller passes the session's). The
   * response body is returned unread so attachments stream through without buffering.
   */
  async download(sessionId: string, accountId: string, blobId: string, name: string): Promise<Response> {
    const { value } = await this.#withSession(sessionId, async (s) => {
      if (s.accountId !== accountId) return { status: 404, limited: false, value: new Response(null, { status: 404 }) };
      const url = `${this.#base}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(name)}?accept=application%2Foctet-stream`;
      const res = await this.#upstream(url, { headers: this.#auth(s.accessToken) });
      if (res.status === 401 || res.status === 403 || res.status === 429) await res.body?.cancel();
      return { status: res.status, limited: res.status === 429, value: res };
    });
    return value;
  }
}
