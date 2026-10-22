// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";

import { log } from "@anhourmail/server/log";
import type { SlidingQuotaStore } from "@anhourmail/server/rate-limit";

import {
  COMPOSED_KEYWORD,
  type DraftInput,
  draftEmail,
  draftProblem,
  type Identity,
  sendCheck,
  sendingLimits,
  sendWindows,
  type StoredDraft,
  UNDO_SECONDS,
} from "./compose";
import { isLimitError, type JmapRequestBody } from "./jmap-policy";
import { QueueFullError, UserQueue, withLimitRetry } from "./queue";
import { MAX_MAILBOXES, type MailboxTokens, type WebmailSession, type WebmailSessionStore } from "./session-store";
import { calendarEvents, type CalendarEvent, MAX_MARKDOWN } from "./body";
import {
  BODY_PROPERTIES,
  type BodyExtras,
  type BodyPart,
  buildMessageView,
  calendarParts,
  markdownPart,
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
/** The mailbox's sending limit for now is used up (per hour / per day, by recipients). → 429 */
export class WebmailQuotaError extends Error {
  override readonly name = "WebmailQuotaError";
}
/** Too much queued for this person, or Stalwart kept refusing on concurrency. → 429 */
export class WebmailBusyError extends Error {
  override readonly name = "WebmailBusyError";
}

/** The request is understood but not allowed for this mailbox (wrong sender, not a draft, not in Trash…). → 400 */
export class WebmailRefusedError extends Error {
  override readonly name = "WebmailRefusedError";
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
  /** Sliding send quotas (Redis in the app). Failures refuse sending (fail closed). */
  quota: SlidingQuotaStore;
  fetch?: typeof fetch;
  queue?: UserQueue;
  now?: () => number;
  /** Refresh when the access token has less than this left (ms). */
  refreshSkewMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const USING = ["urn:ietf:params:jmap:core", MAIL];
const USING_SUBMISSION = [...USING, SUBMISSION];
/** Mailbox roles and identities change rarely: cache them per account for this long. */
const META_TTL_MS = 60_000;

export type Roles = Partial<Record<"inbox" | "drafts" | "sent" | "archive" | "junk" | "trash", string>>;
/** Body cap for "View entire message" (bytes). */
export const MAX_FULL_BODY_BYTES = 8_000_000;

type Sanitize = (
  html: string,
  inline: ReadonlyMap<string, string>,
) => { html: string; blockedImages: number; blockedTrackers: number };

/** Inline images we embed as data: URIs: per image and per message. */
const MAX_INLINE_IMAGE = 512 * 1024;
const MAX_INLINE_TOTAL = 2 * 1024 * 1024;

export class WebmailService {
  readonly #d: Required<Omit<WebmailDeps, "sleep">> & { sleep?: (ms: number) => Promise<void> };
  readonly #base: string;
  /** One refresh at a time per session (several tabs or calls may notice expiry together). */
  readonly #refreshing = new Map<string, Promise<WebmailSession | null>>();
  readonly #roles = new Map<string, { at: number; roles: Roles }>();
  readonly #identities = new Map<string, { at: number; list: Identity[] }>();

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

  /** Exchanges a mailbox address and password for that mailbox's tokens (password used once, never kept). */
  async #authenticate(address: string, password: string): Promise<MailboxTokens> {
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
    return {
      username: s.username,
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  }

  /** Signs in with the mailbox address and password (used once here, never stored or logged). */
  async signIn(address: string, password: string): Promise<{ sessionId: string; session: WebmailSession }> {
    const session: WebmailSession = { ...(await this.#authenticate(address, password)), createdAt: this.#d.now() };
    const sessionId = await this.#d.store.create(session);
    return { sessionId, session };
  }

  /** The mailboxes signed in to this session, the active one first. */
  async mailboxes(sessionId: string): Promise<{ active: string; others: string[] } | null> {
    const s = await this.session(sessionId);
    if (!s) return null;
    return { active: s.username, others: (s.others ?? []).map((m) => m.username) };
  }

  /**
   * Signs another mailbox in to the same session ("Add another mailbox") and makes it active. Signing in to one
   * that is already there just renews its tokens. At most `MAX_MAILBOXES` per session.
   */
  async addMailbox(sessionId: string, address: string, password: string): Promise<WebmailSession> {
    if (!(await this.session(sessionId))) throw new WebmailSignedOutError("signed out");
    const added = await this.#authenticate(address, password);
    return this.#update(sessionId, (current) => {
      const { others = [], createdAt, version, ...active } = current;
      const rest = [active, ...others].filter((m) => m.username !== added.username);
      if (rest.length + 1 > MAX_MAILBOXES) {
        throw new WebmailRefusedError(`You can have ${String(MAX_MAILBOXES)} mailboxes open at once.`);
      }
      return { ...added, createdAt, version, others: rest };
    });
  }

  /** Makes another signed-in mailbox the active one. Unknown addresses are refused. */
  async switchMailbox(sessionId: string, username: string): Promise<WebmailSession> {
    const current = await this.session(sessionId);
    if (!current) throw new WebmailSignedOutError("signed out");
    if (current.username === username) return current;
    const target = (current.others ?? []).find((m) => m.username === username);
    if (!target) throw new WebmailRefusedError("That mailbox isn't signed in here.");
    if (!(await this.#d.access.allowed(target.username))) {
      // That one is suspended or gone: drop it, keep the session on the current mailbox.
      await this.#update(sessionId, (cur) => ({
        ...cur,
        others: (cur.others ?? []).filter((m) => m.username !== username),
      }));
      throw new WebmailRefusedError("This mailbox can't be used right now.");
    }
    return this.#update(sessionId, (cur) => {
      const { others = [], createdAt, version, ...active } = cur;
      const t = others.find((m) => m.username === username);
      if (!t) throw new WebmailRefusedError("That mailbox isn't signed in here.");
      return { ...t, createdAt, version, others: [active, ...others.filter((m) => m !== t)] };
    });
  }

  /**
   * Read-modify-write of the session record with compare-and-set: if another write landed in between (a refresh,
   * another tab's switch), re-read and apply `change` again, a few times at most.
   */
  async #update(sessionId: string, change: (current: WebmailSession) => WebmailSession): Promise<WebmailSession> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.#d.store.read(sessionId);
      if (!current) throw new WebmailSignedOutError("signed out");
      const next = change(current);
      if (await this.#d.store.write(sessionId, next)) return { ...next, version: (next.version ?? 0) + 1 };
    }
    throw new WebmailBusyError("session busy");
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
      // Compare-and-set: signed out meanwhile → nothing written; switched mailbox meanwhile → keep that change and
      // use what is stored now (it refreshes on its own next use).
      if (await this.#d.store.write(sessionId, next)) return { ...next, version: (s.version ?? 0) + 1 };
      return await this.#d.store.read(sessionId);
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

  /**
   * Forwards an allow-listed JMAP request (already checked by `checkJmapRequest`). Messages it would destroy must
   * all be in Trash or Junk only ("delete forever"); anything else is refused before Stalwart sees the request.
   */
  async jmap(
    sessionId: string,
    body: JmapRequestBody,
    destroyIds: string[] = [],
  ): Promise<{ status: number; body: unknown }> {
    if (destroyIds.length > 0) await this.#assertDisposable(sessionId, destroyIds);
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

  /**
   * One message, sanitised for the reader. Null when the id is not in this mailbox. `full` raises the body cap
   * ("View entire message") from 1 MB to `MAX_FULL_BODY_BYTES`.
   */
  async message(
    sessionId: string,
    emailId: string,
    sanitize: Sanitize,
    toText: (html: string) => string = (h) => h,
    opts: { full?: boolean } = {},
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
              maxBodyValueBytes: opts.full ? MAX_FULL_BODY_BYTES : MAX_BODY_BYTES,
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
    return this.#view(sessionId, accountId, email, sanitize, toText);
  }

  /** Builds the reader view: inline images, a markdown body and calendar invitations fetched as small blobs. */
  async #view(
    sessionId: string,
    accountId: string,
    email: JmapEmail,
    sanitize: Sanitize,
    toText: (html: string) => string,
    opts: { blobs?: boolean } = {},
  ): Promise<MessageView> {
    const blobs = opts.blobs ?? true;
    const text = async (part: BodyPart, max: number): Promise<string | undefined> => {
      if (!blobs || !part.blobId || part.size > max) return undefined;
      const res = await this.download(sessionId, accountId, part.blobId, "part");
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > max) return undefined;
      try {
        return new TextDecoder(part.charset ?? "utf-8").decode(bytes);
      } catch {
        return new TextDecoder("utf-8").decode(bytes);
      }
    };

    // Inline images referenced by cid: become data: URIs (bounded), never URLs the frame could fetch.
    const inline = new Map<string, string>();
    let total = 0;
    for (const part of blobs ? inlineImageParts(email) : []) {
      if (part.size > MAX_INLINE_IMAGE || total + part.size > MAX_INLINE_TOTAL || !part.blobId) continue;
      const blob = await this.download(sessionId, accountId, part.blobId, "inline");
      if (!blob.ok) {
        await blob.body?.cancel();
        continue;
      }
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.length > MAX_INLINE_IMAGE) continue;
      total += bytes.length;
      inline.set(
        (part.cid ?? "").replace(/^<|>$/g, ""),
        `data:${part.type.toLowerCase()};base64,${bytes.toString("base64")}`,
      );
    }

    const extras: BodyExtras = {};
    const md = markdownPart(email);
    if (md) {
      const v = await text(md, MAX_MARKDOWN);
      if (v !== undefined) extras.markdown = v;
    }
    const events: CalendarEvent[] = [];
    for (const part of calendarParts(email)) {
      const v = await text(part, 256 * 1024);
      if (v !== undefined) events.push(...calendarEvents(v, 5 - events.length));
    }
    if (events.length > 0) extras.events = events;
    return buildMessageView(email, (html) => sanitize(html, inline), toText, extras);
  }

  /**
   * A message attached to (or forwarded inside) another one, read with `Email/parse`. `blobId` must be a
   * message/rfc822 attachment of `emailId` in this mailbox; null otherwise.
   */
  async attachedMessage(
    sessionId: string,
    emailId: string,
    blobId: string,
    sanitize: Sanitize,
    toText: (html: string) => string = (h) => h,
  ): Promise<MessageView | null> {
    let accountId = "";
    const r = await this.#call(sessionId, (s) => {
      accountId = s.accountId;
      return [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["attachments"] }, "g"]];
    });
    const parent = ((r.get("g")?.list ?? []) as { attachments: BodyPart[] | null }[])[0];
    const part = parent?.attachments?.find((p) => p.blobId === blobId && /^message\/rfc822$/i.test(p.type));
    if (!part) return null;
    const parsed = await this.#call(sessionId, (s) => [
      [
        "Email/parse",
        {
          accountId: s.accountId,
          blobIds: [blobId],
          properties: [
            "from",
            "to",
            "cc",
            "replyTo",
            "subject",
            "sentAt",
            "receivedAt",
            "messageId",
            "references",
            "htmlBody",
            "textBody",
            "attachments",
            "bodyValues",
          ],
          bodyProperties: BODY_PROPERTIES,
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
          maxBodyValueBytes: MAX_BODY_BYTES,
        },
        "p",
      ],
    ]);
    const email = (parsed.get("p")?.parsed as Record<string, Partial<JmapEmail>> | undefined)?.[blobId];
    if (!email) return null;
    const full: JmapEmail = {
      id: emailId,
      threadId: "",
      mailboxIds: {},
      keywords: { $seen: true },
      from: null,
      to: null,
      cc: null,
      replyTo: null,
      subject: null,
      sentAt: null,
      htmlBody: null,
      textBody: null,
      attachments: null,
      bodyValues: null,
      ...email,
      receivedAt: email.receivedAt ?? email.sentAt ?? new Date(this.#d.now()).toISOString(),
      blobId,
    };
    // Parts of a parsed message aren't separate blobs in the mailbox: no inline images or side parts (blocked).
    return this.#view(sessionId, accountId, full, sanitize, toText, { blobs: false });
  }

  /** The original message (RFC 5322 source) as a stream; null when the id isn't in this mailbox. */
  async raw(sessionId: string, emailId: string): Promise<Response | null> {
    let accountId = "";
    const r = await this.#call(sessionId, (s) => {
      accountId = s.accountId;
      return [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["blobId", "size"] }, "g"]];
    });
    const e = ((r.get("g")?.list ?? []) as { blobId: string; size: number }[])[0];
    if (!e) return null;
    return this.download(sessionId, accountId, e.blobId, "message.eml");
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

  /** Runs server-built calls and returns responses by call id; a method error is "unavailable". */
  async #call(
    sessionId: string,
    build: (s: WebmailSession) => [string, Record<string, unknown>, string][],
    using: string[] = USING,
    /** Refuse if the active mailbox is no longer this account (it was switched during a multi-step action). */
    expectAccount?: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const res = (await this.jmapAs(sessionId, (s) => {
      if (expectAccount !== undefined && s.accountId !== expectAccount) {
        throw new WebmailRefusedError("Your active mailbox changed. Try again.");
      }
      return { using, methodCalls: build(s) };
    })) as {
      methodResponses?: [string, Record<string, unknown>, string][];
    } | null;
    const out = new Map<string, Record<string, unknown>>();
    for (const [name, args, id] of res?.methodResponses ?? []) {
      if (name === "error") {
        log.warn("webmail method error", { component: "webmail", type: String(args.type) });
        throw new WebmailUnavailableError("mail server error");
      }
      if (!out.has(id)) out.set(id, args);
    }
    return out;
  }

  /** The active mailbox's account id (signed-out → error). */
  async #accountId(sessionId: string): Promise<string> {
    const s = await this.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    return s.accountId;
  }

  /** Ids of the special folders (Drafts, Sent, Trash, Junk…) of the active mailbox, cached for a minute. */
  async roles(sessionId: string): Promise<Roles> {
    const accountId = await this.#accountId(sessionId);
    const hit = this.#roles.get(accountId);
    if (hit && this.#d.now() - hit.at < META_TTL_MS) return hit.roles;
    const r = await this.#call(sessionId, (s) => [
      ["Mailbox/get", { accountId: s.accountId, ids: null, properties: ["role"] }, "m"],
    ]);
    const roles: Roles = {};
    for (const m of (r.get("m")?.list ?? []) as { id: string; role: string | null }[]) {
      if (m.role && ["inbox", "drafts", "sent", "archive", "junk", "trash"].includes(m.role)) {
        roles[m.role as keyof Roles] ??= m.id;
      }
    }
    this.#roles.set(accountId, { at: this.#d.now(), roles });
    return roles;
  }

  /** The active mailbox's sending identities (its address, aliases, masked aliases), cached for a minute. */
  async identities(sessionId: string): Promise<Identity[]> {
    const accountId = await this.#accountId(sessionId);
    const hit = this.#identities.get(accountId);
    if (hit && this.#d.now() - hit.at < META_TTL_MS) return hit.list;
    const r = await this.#call(
      sessionId,
      (s) => [["Identity/get", { accountId: s.accountId, ids: null, properties: ["name", "email"] }, "i"]],
      USING_SUBMISSION,
    );
    const list = ((r.get("i")?.list ?? []) as Identity[]).map((i) => ({ id: i.id, name: i.name, email: i.email }));
    this.#identities.set(accountId, { at: this.#d.now(), list });
    return list;
  }

  async #identity(sessionId: string, identityId: string): Promise<Identity> {
    const identity = (await this.identities(sessionId)).find((i) => i.id === identityId);
    if (!identity) throw new WebmailRefusedError("You can only send from your own addresses.");
    return identity;
  }

  async #assertDisposable(sessionId: string, ids: string[]): Promise<void> {
    const roles = await this.roles(sessionId);
    const disposable = new Set([roles.trash, roles.junk].filter((x): x is string => x !== undefined));
    const r = await this.#call(sessionId, (s) => [
      ["Email/get", { accountId: s.accountId, ids, properties: ["mailboxIds"] }, "g"],
    ]);
    const found = (r.get("g")?.list ?? []) as { id: string; mailboxIds: Record<string, boolean> }[];
    const ok =
      found.length > 0 &&
      found.every((e) => {
        const boxes = Object.keys(e.mailboxIds).filter((k) => e.mailboxIds[k]);
        return boxes.length > 0 && boxes.every((b) => disposable.has(b));
      });
    if (!ok) throw new WebmailRefusedError("Only messages in Trash or Junk can be deleted forever.");
  }

  /** Saves a draft (replacing the previous version of it), from one of the person's own identities. */
  async saveDraft(sessionId: string, input: DraftInput): Promise<{ id: string }> {
    const problem = draftProblem(input);
    if (problem) throw new WebmailRefusedError(problem.message);
    const [identity, roles] = await Promise.all([this.#identity(sessionId, input.identityId), this.roles(sessionId)]);
    const drafts = roles.drafts;
    if (!drafts) throw new WebmailUnavailableError("no Drafts folder");
    if (input.replaces) {
      const old = await this.#draft(sessionId, input.replaces);
      // Only drafts the BFF built are replaced (destroyed): never an arbitrary message promoted to a draft.
      if (old?.mailboxIds[drafts] !== true || old.keywords.$draft !== true || old.keywords[COMPOSED_KEYWORD] !== true) {
        throw new WebmailRefusedError("That draft can't be changed.");
      }
    }
    const r = await this.#call(sessionId, (s) => [
      [
        "Email/set",
        {
          accountId: s.accountId,
          create: { draft: draftEmail(input, identity, drafts) },
          ...(input.replaces ? { destroy: [input.replaces] } : {}),
        },
        "d",
      ],
    ]);
    const created = (r.get("d")?.created as Record<string, { id: string }> | undefined)?.draft;
    if (!created) {
      const why = (r.get("d")?.notCreated as Record<string, { type?: string }> | undefined)?.draft?.type;
      log.warn("webmail draft not saved", { component: "webmail", type: why ?? "unknown" });
      throw new WebmailRefusedError(
        why === "overQuota" ? "Your mailbox is full: the draft couldn't be saved." : "The draft couldn't be saved.",
      );
    }
    return { id: created.id };
  }

  async #draft(sessionId: string, id: string): Promise<StoredDraft | null> {
    const r = await this.#call(sessionId, (s) => [
      [
        "Email/get",
        {
          accountId: s.accountId,
          ids: [id],
          properties: ["mailboxIds", "keywords", "from", "to", "cc", "bcc", "size"],
        },
        "g",
      ],
    ]);
    return ((r.get("g")?.list ?? []) as StoredDraft[])[0] ?? null;
  }

  /**
   * Sends a saved draft as one of the person's identities. The submission is held for `UNDO_SECONDS`
   * (FUTURERELEASE) so `undoSend` can cancel it; on success Stalwart moves it to Sent.
   */
  async send(
    sessionId: string,
    draftId: string,
    identityId: string,
  ): Promise<{ submissionId: string; sendAt: string }> {
    // Everything below runs against this mailbox: the quota is charged to it, and every call refuses if the active
    // mailbox changes meanwhile.
    const s = await this.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    const account = s.accountId;
    const limits = sendingLimits(s.username);
    const [identity, roles] = await Promise.all([this.#identity(sessionId, identityId), this.roles(sessionId)]);
    if (!roles.drafts || !roles.sent) throw new WebmailUnavailableError("no Drafts or Sent folder");
    const drafts = roles.drafts;
    const sent = roles.sent;
    const draft = (
      (
        await this.#call(
          sessionId,
          (x) => [
            [
              "Email/get",
              {
                accountId: x.accountId,
                ids: [draftId],
                properties: ["mailboxIds", "keywords", "from", "to", "cc", "bcc", "size"],
              },
              "g",
            ],
          ],
          USING,
          account,
        )
      ).get("g")?.list as StoredDraft[] | undefined
    )?.[0];
    if (!draft) throw new WebmailRefusedError("Only a saved draft can be sent.");
    const check = sendCheck(draft, identity, drafts, limits);
    if (!check.ok) throw new WebmailRefusedError(check.message);

    // Published trust-tier limits, per hour and per day, per mailbox and per session, one unit per recipient.
    // A quota store failure refuses (fail closed, rule 27).
    const sessionKey = createHash("sha256").update(sessionId).digest("base64url").slice(0, 22);
    let allowed: boolean;
    try {
      allowed = await this.#d.quota.take(
        sendWindows(s.username, sessionKey, limits),
        check.rcptTo.length,
        this.#d.now(),
        randomBytes(8).toString("hex"),
      );
    } catch (err) {
      log.warn("webmail send quota unavailable", { component: "webmail", err });
      throw new WebmailUnavailableError("sending is unavailable right now");
    }
    if (!allowed) {
      throw new WebmailQuotaError(
        `You've reached your sending limit for now (${String(limits.messagesPerHour)} recipients an hour, ${String(limits.messagesPerDay)} a day). Try again later.`,
      );
    }

    const r = await this.#call(
      sessionId,
      (x) => [
        [
          "EmailSubmission/set",
          {
            accountId: x.accountId,
            create: {
              send: {
                identityId: identity.id,
                emailId: draftId,
                envelope: {
                  mailFrom: { email: identity.email, parameters: { HOLDFOR: String(UNDO_SECONDS) } },
                  rcptTo: check.rcptTo.map((email) => ({ email })),
                },
              },
            },
            onSuccessUpdateEmail: {
              "#send": { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, "keywords/$draft": null },
            },
          },
          "s",
        ],
      ],
      USING_SUBMISSION,
      account,
    );
    const created = (r.get("s")?.created as Record<string, { id: string; sendAt?: string }> | undefined)?.send;
    if (!created) {
      const why = (r.get("s")?.notCreated as Record<string, { type?: string }> | undefined)?.send?.type;
      log.warn("webmail submission refused", { component: "webmail", type: why ?? "unknown" });
      throw new WebmailRefusedError("The mail server didn't accept this message.");
    }
    return { submissionId: created.id, sendAt: created.sendAt ?? new Date(this.#d.now()).toISOString() };
  }

  /** Cancels a held submission and puts its message back in Drafts. "Already sent" when it is too late. */
  async undoSend(sessionId: string, submissionId: string): Promise<{ draftId: string }> {
    const roles = await this.roles(sessionId);
    if (!roles.drafts || !roles.sent) throw new WebmailUnavailableError("no Drafts or Sent folder");
    const drafts = roles.drafts;
    const sent = roles.sent;
    const r = await this.#call(
      sessionId,
      (s) => [
        [
          "EmailSubmission/get",
          { accountId: s.accountId, ids: [submissionId], properties: ["emailId", "undoStatus"] },
          "g",
        ],
        [
          "EmailSubmission/set",
          { accountId: s.accountId, update: { [submissionId]: { undoStatus: "canceled" } } },
          "u",
        ],
      ],
      USING_SUBMISSION,
    );
    const sub = ((r.get("g")?.list ?? []) as { emailId: string; undoStatus: string }[])[0];
    const updated = r.get("u")?.updated as Record<string, unknown> | undefined;
    if (!sub || !updated || !(submissionId in updated)) throw new WebmailRefusedError("It has already been sent.");
    await this.#call(sessionId, (s) => [
      [
        "Email/set",
        {
          accountId: s.accountId,
          update: {
            [sub.emailId]: { [`mailboxIds/${sent}`]: null, [`mailboxIds/${drafts}`]: true, "keywords/$draft": true },
          },
        },
        "e",
      ],
    ]);
    return { draftId: sub.emailId };
  }

  /** Uploads one attachment (already size-capped by the caller) to the active mailbox. */
  async upload(
    sessionId: string,
    bytes: Uint8Array<ArrayBuffer>,
    type: string,
  ): Promise<{ blobId: string; type: string; size: number }> {
    const { value } = await this.#withSession(sessionId, async (s) => {
      const res = await this.#upstream(`${this.#base}/jmap/upload/${encodeURIComponent(s.accountId)}/`, {
        method: "POST",
        headers: { ...this.#auth(s.accessToken), "Content-Type": type },
        body: bytes,
      });
      const json: unknown = await res.json().catch(() => null);
      return { status: res.status, limited: isLimitError(res.status, json), value: { status: res.status, body: json } };
    });
    const body = value.body as { blobId?: unknown; size?: unknown } | null;
    if (value.status === 413) throw new WebmailRefusedError("That file is too large.");
    if (value.status >= 300 || typeof body?.blobId !== "string") {
      log.warn("webmail upload failed", { component: "webmail", status: value.status });
      throw new WebmailUnavailableError("upload failed");
    }
    return { blobId: body.blobId, type, size: typeof body.size === "number" ? body.size : bytes.length };
  }
}
