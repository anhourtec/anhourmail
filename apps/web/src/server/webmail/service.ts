// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { DelegatedMailboxRefusedError, type RequestMeta } from "@anhourmail/core";
import {
  type ConsoleBinding,
  CredentialSlotTakenError,
  type DelegatedEntry,
  type DelegatedMailbox,
  type DelegatedSendAuthorization,
  type DelegatedSendInput,
  type DelegatedSendMode,
  type DelegatedSendOutcome,
  type DelegatedTarget,
  type DelegationNeed,
  ON_BEHALF_EXPIRES_HEADER,
  ON_BEHALF_HEADER,
  onBehalfExpires,
  onBehalfTag,
  OnBehalfTagError,
  sendMode,
  type WebmailAccess,
  type WebmailRefusal,
} from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import type { SlidingQuotaStore } from "@anhourmail/server/rate-limit";
import { DELEGATED_MAILBOXES_PER_PERSON } from "@anhourmail/shared/plans";

import {
  COMPOSED_KEYWORD,
  DraftInput as DraftInputSchema,
  type DraftInput,
  draftEmail,
  draftProblem,
  type Identity,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  delegatedSendingLimits,
  sendCheck,
  senderName,
  sendingLimits,
  sendWindows,
  type StoredDraft,
  UNDO_SECONDS,
} from "./compose";
import { isLimitError, type JmapRequestBody } from "./jmap-policy";
import {
  buildScript,
  DEFAULT_RULES,
  fitContacts,
  MAILBOX_RULES_LIMIT_MESSAGE,
  MAX_SCRIPT_BYTES,
  type MailRules,
  parseScript,
  usesContacts,
} from "./sieve";
import { QueueFullError, UserQueue, withLimitRetry } from "./queue";
import { MAX_MAILBOXES, type MailboxTokens, type WebmailSession, type WebmailSessionStore } from "./session-store";
import { pinnedAddress, pinnedKind, withPinnedMailbox } from "./pin";
import { calendarEvents, type CalendarEvent, MAX_MARKDOWN } from "./body";
import {
  AUTO_SAVE_OFF,
  AUTO_SAVE_ON,
  type BookView,
  CARD_PROPERTIES,
  cardFields,
  type ContactInput,
  type ContactView,
  contactView,
  MAX_CONTACTS,
  newCard,
  OTHER_BOOK_NAME,
  parseVcards,
  toVcards,
} from "./contacts";
import {
  type Address,
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
 * The mailbox is suspended, being deleted or gone from the control plane, or the person it belongs to is suspended:
 * the session is ended even though Stalwart may still accept its tokens. → 401 with a message for `reason`
 */
export class WebmailBlockedError extends Error {
  override readonly name = "WebmailBlockedError";
  constructor(
    message: string,
    /** Why (the mail server's own 403 on a suspended account is `suspended`). */
    readonly reason: WebmailRefusal = "suspended",
  ) {
    super(message);
  }
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

/**
 * A delegated mailbox the session held or asked for can't be used (no grant now, unknown, another account's, the plan,
 * the mailbox's state): the entry is dropped and the answer is 404 "You don't have access to this mailbox." in every
 * case (ADR-0026 §6, rule 25). The session itself goes on with the person's own mailbox.
 */
export class WebmailDelegationRefusedError extends Error {
  override readonly name = "WebmailDelegationRefusedError";
}

/**
 * The active mailbox is one shared with the person (a delegated entry) and this needs their own: sending (until send
 * rights are used), drafts, uploads, identities, settings, contacts and export (ADR-0026 §6 "What each right allows").
 * → 403
 */
export class WebmailOwnMailboxOnlyError extends Error {
  override readonly name = "WebmailOwnMailboxOnlyError";
}

/**
 * A delegated send whose submission answer was lost and whose state the mail server couldn't be asked about: it may
 * have been sent. → 503 `send_unconfirmed` ("Check Sent before sending it again."), never a plain failure.
 */
export class WebmailSendUnconfirmedError extends Error {
  override readonly name = "WebmailSendUnconfirmedError";
}

/** The OAuth port refused the credentials or the grant (wrong password, revoked refresh token). */
export class GrantRefusedError extends Error {
  override readonly name = "GrantRefusedError";
}

/** "Show original": summary fields from the mail server plus the source as text (first part when `cut`). */
export type OriginalMessage = {
  id: string;
  messageId: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  size: number;
  text: string;
  cut: boolean;
};

export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: number };

/** Stalwart's OAuth server, behind an adapter (apps/web/src/server/adapters/stalwart-oauth.ts). */
export type OAuthPort = {
  signIn(accountName: string, accountSecret: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
};

/**
 * Delegated mailboxes (ADR-0026 §6), wired to core `@anhourmail/core/webmail` `delegation.ts`: the auto-mapping list,
 * the audited open (mint → exchange → destroy under the locks) and the per-request gate.
 */
export type WebmailDelegation = {
  list(owners: readonly string[]): Promise<DelegatedMailbox[]>;
  open(
    input: { owners: readonly string[]; address: string; console: ConsoleBinding | null; need?: DelegationNeed },
    signIn: (target: DelegatedTarget) => Promise<MailboxTokens>,
    req: RequestMeta,
  ): Promise<{ value: MailboxTokens; mailbox: DelegatedMailbox }>;
  gate: { allowed(session: string, entry: DelegatedEntry): Promise<boolean>; forget(session: string): void };
  /**
   * The send right checked now (uncached) and the send audited before anything is submitted (core
   * `authorizeDelegatedSend`): which right is used, send as winning. Refusals throw (404, act-as 403).
   */
  authorizeSend(input: DelegatedSendInput, req: RequestMeta): Promise<DelegatedSendAuthorization>;
  /** The send right now, uncached and read-only (the last check before the submission); null when refused. */
  checkSend(input: Omit<DelegatedSendInput, "recipientCount">): Promise<DelegatedSendMode | null>;
  /**
   * Records what became of an audited send (core `recordDelegatedSendOutcome`): undone (`delegation.send_cancelled`),
   * never submitted (`delegation.send_failed`), or its tagged temporary copy left behind (`delegation.tagged_copy_left`).
   */
  sendOutcome(
    input: { mailboxId: string; granteeUserId: string; via: string },
    outcome: DelegatedSendOutcome,
    req: RequestMeta,
  ): Promise<void>;
};

/** One entry of the From picker beyond the person's own identities (ADR-0026 §6): a mailbox shared with them. */
export type DelegatedSender = {
  /** The mailbox's address: the From of the message. */
  mailbox: string;
  /** Which right is used (send as wins when both are held). */
  mode: "send_as" | "send_on_behalf";
  /** "desk@…" for send as, "<you> on behalf of desk@…" for send on behalf. */
  label: string;
};

/** What `send` answers. `from` is the delegated mailbox a message went from (absent for the person's own). */
export type SendResult = { submissionId: string; sendAt: string; holdSeconds: number; from?: string };

/** A mailbox shared with the session's people, for the switcher, the sidebar and (later) the From picker. */
export type SharedMailboxView = {
  address: string;
  /** The person's own mailbox it comes through. */
  via: string;
  fullAccess: boolean;
  sendAs: boolean;
  sendOnBehalf: boolean;
  /** Its tokens are in this session already (opened before). */
  open: boolean;
};

/** What `mailboxes()` answers: the active mailbox, the session's own others, and what is shared with its people. */
export type MailboxList = { active: string; activeShared: boolean; others: string[]; shared: SharedMailboxView[] };

export type WebmailDeps = {
  store: WebmailSessionStore;
  oauth: OAuthPort;
  /**
   * The console → webmail handoff (ADR-0024): mints a throwaway mail-server credential for the mailbox, signs in once
   * with it and destroys it, returning ordinary webmail tokens. Absent: the handoff isn't available.
   */
  handoffSignIn?: (target: { address: string; externalId: string }) => Promise<OAuthTokens>;
  /**
   * Whether a console session still exists (`session_id` of the person). A handoff-born webmail session ends with
   * its console session; "alive" answers are cached for 30 s at most.
   */
  consoleSessionAlive?: (userId: string, sessionId: string) => Promise<boolean>;
  /** Delegated mailboxes (ADR-0026). Absent: nothing is shared, and a session never holds a delegated entry. */
  delegation?: WebmailDelegation;
  /**
   * `SENDER_DELEGATION_KEY` (ADR-0026 §8), read when a send on behalf is made (web app only, never the worker). Absent
   * or throwing: sends on behalf are refused (send as and the person's own mail still work).
   */
  onBehalfKey?: () => string;
  /** Stalwart's HTTP base URL (internal network). */
  stalwartUrl: string;
  /** Control-plane gate: may this mailbox use the webmail now, and if not why? (core `MailboxAccessGate`, ≤ 30 s) */
  access: { state(address: string): Promise<WebmailAccess> };
  /** Sliding send quotas (Redis in the app). Failures refuse sending (fail closed). */
  quota: SlidingQuotaStore;
  fetch?: typeof fetch;
  queue?: UserQueue;
  now?: () => number;
  /** Refresh when the access token has less than this left (ms). */
  refreshSkewMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs `fn` later (auto-saving recipients once the undo hold is over). Defaults to an unref'd timer. */
  defer?: (fn: () => void, ms: number) => void;
  /** The mailbox's chosen undo-send hold in seconds (its webmail preferences); `UNDO_SECONDS` when unset. */
  holdSeconds?: (address: string) => Promise<number>;
  /** The managed Sieve script (automatic replies, forwarding, junk rules), via management credentials. */
  sieve: ManagedSieve;
  /**
   * The mailbox's confirmed forwarding target in the control plane (`forwarding_target`), or null. Every rules write
   * keeps a redirect only to this address — never what the script comment or the caller says.
   */
  confirmedForward: (address: string) => Promise<string | null>;
  /**
   * The authserv-ids of our own mail server's results headers (the reader's trusted ids), for the forwarding rule's
   * DMARC check. The app wires it (`instance.ts`); without it the rule has no ids and forwards as before.
   */
  authservIds?: () => readonly string[];
};

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const USING = ["urn:ietf:params:jmap:core", MAIL];
const USING_SUBMISSION = [...USING, SUBMISSION];
const USING_CONTACTS = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];
const USING_QUOTA = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:quota"];

/** Whether the managed rules are in force: none written yet, active, or switched off (re-activated on next save). */
export type RulesState = "none" | "active" | "inactive";

/**
 * The mailbox's one managed Sieve script, read and written with management credentials (customer mailboxes can't
 * manage their own Sieve — `CUSTOMER_PERMISSIONS`). `accountId` is the mailbox's JMAP account id. Behind the
 * stalwart-client management port; faked in tests.
 */
export type ManagedSieve = {
  /** The script and whether it's the active one, or null when the mailbox has none yet. */
  read(accountId: string): Promise<{ content: string; active: boolean } | null>;
  /** Writes it and makes it the active one. */
  write(accountId: string, script: string): Promise<void>;
};

/** How long a proof that the session's own mailbox still signs in (for delegated use) holds: the gate's cache, 10 s. */
const VIA_PROOF_MS = 10_000;

/** A delegated send in its undo hold (`#heldSends`). */
type HeldSend = {
  /** The delegated entry it went from. */
  mailbox: string;
  mailboxId: string;
  granteeUserId: string;
  via: string;
  /** The copy kept in that mailbox's Sent (destroyed by undo). */
  storedId: string;
  /** The person's own draft it was built from (destroyed once the hold is over; kept, and answered, by undo). */
  ownDraftId: string;
  ownAccount: string;
  /** Epoch ms after which it is forgotten. */
  until: number;
};

/** A saved draft with what rebuilding it in another mailbox needs (`#sendDelegated`). */
type FullDraft = StoredDraft & {
  subject: string | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  textBody: { partId?: string | null; type: string }[] | null;
  htmlBody: { partId?: string | null; type: string }[] | null;
  bodyValues: Record<string, { value: string; isTruncated?: boolean }> | null;
  attachments: { blobId: string | null; name: string | null; type: string; size: number }[] | null;
};

/** At most this many recipients of one message are saved to Other contacts. */
const MAX_AUTO_SAVE = 100;
/** Cards per `ContactCard/get` (the server's `getMaxResults`); MAX_CONTACTS / CARD_BATCH ≤ 16 calls a request. */
const CARD_BATCH = 500;
const CONTACTS_FULL = `A mailbox can keep up to ${MAX_CONTACTS.toLocaleString("en-CA")} contacts. Delete some to add more.`;
/** Mailbox roles and identities change rarely: cache them per account for this long. */
const META_TTL_MS = 60_000;

export type Roles = Partial<Record<"inbox" | "drafts" | "sent" | "archive" | "junk" | "trash", string>>;
/** Body cap for "View entire message" (bytes). */
export const MAX_FULL_BODY_BYTES = 8_000_000;

type Sanitize = (
  html: string,
  inline: ReadonlyMap<string, string>,
) => { html: string; blockedImages: number; blockedTrackers: number; loadableImages?: number };

/** Inline images we embed as data: URIs: per image and per message. */
const MAX_INLINE_IMAGE = 512 * 1024;
const MAX_INLINE_TOTAL = 2 * 1024 * 1024;

/**
 * Whether a server-built call may use a delegated entry's token: only the read-and-manage paths say `READ` (message
 * views, downloads, roles, the proxy); everything else is the person's own mailbox only (default-deny, ADR-0026 §6).
 */
export type Access = "own" | "read";
/** Capabilities only the person's own mailbox is used with. */
const OWN_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  "urn:ietf:params:jmap:submission",
  "urn:ietf:params:jmap:contacts",
  "urn:ietf:params:jmap:quota",
]);
const OWN: Access = "own";
const READ: Access = "read";

/**
 * The session's own active mailbox, for callers outside this class that act on "the mailbox of this session" from a
 * single read (settings, password, photos, export): a mailbox shared with the person is refused.
 */
export function ownMailbox(s: WebmailSession | null): WebmailSession {
  if (!s) throw new WebmailSignedOutError("signed out");
  if (s.delegated) throw new WebmailOwnMailboxOnlyError("own mailbox only");
  return s;
}

/** The session's own signed-in mailboxes (never delegated entries), the active one first. */
function ownEntries(s: WebmailSession): MailboxTokens[] {
  return [s, ...(s.others ?? [])].filter((m) => !m.delegated);
}

/** The delegated entries the session holds (opened before), the active one first. */
function delegatedEntries(s: WebmailSession): MailboxTokens[] {
  return [s, ...(s.others ?? [])].filter((m) => m.delegated !== undefined);
}

export class WebmailService {
  readonly #d: Required<
    Omit<WebmailDeps, "sleep" | "handoffSignIn" | "consoleSessionAlive" | "delegation" | "onBehalfKey">
  > &
    Pick<WebmailDeps, "sleep" | "handoffSignIn" | "consoleSessionAlive" | "delegation" | "onBehalfKey">;
  /** Console sessions seen alive recently (handoff-born webmail sessions), until when. */
  readonly #consoleAlive = new Map<string, number>();
  readonly #base: string;
  /**
   * One refresh at a time per session and mailbox (several tabs or calls may notice expiry together). Keyed by the
   * mailbox too: a tab pinned to a shared mailbox (`pin.ts`) refreshes that entry while another tab uses another.
   */
  readonly #refreshing = new Map<string, Promise<WebmailSession | null>>();
  readonly #roles = new Map<string, { at: number; roles: Roles }>();
  readonly #identities = new Map<string, { at: number; list: Identity[] }>();
  /** Own mailboxes of a session proven against the mail server for delegated use (ADR-0026), until when. */
  readonly #viaProven = new Map<string, number>();
  /**
   * Delegated sends still in their undo hold, by session, mailbox and submission: what undo needs (the stored copy
   * in that mailbox, the person's own draft) and what the end of the hold cleans up. In this process only, like the
   * contacts auto-save (a restart in those seconds leaves the own draft behind; the message is sent).
   */
  readonly #heldSends = new Map<string, HeldSend>();

  constructor(deps: WebmailDeps) {
    this.#d = {
      fetch: fetch,
      authservIds: () => [],
      queue: new UserQueue(),
      now: Date.now,
      refreshSkewMs: 60_000,
      defer: (fn, ms) => {
        // Unref'd: a pending auto-save never keeps the process alive.
        setTimeout(fn, ms).unref();
      },
      holdSeconds: async () => UNDO_SECONDS,
      ...deps,
    };
    this.#base = deps.stalwartUrl.replace(/\/+$/, "");
    // Deferred work (the end of an undo hold, contacts auto-save) runs outside any pin of the request that scheduled
    // it (`pin.ts`), on the session as it is then.
    const defer = this.#d.defer;
    this.#d.defer = (fn, ms) => {
      defer(() => {
        withPinnedMailbox(null, fn);
      }, ms);
    };
  }

  get store(): WebmailSessionStore {
    return this.#d.store;
  }

  /** Throws `WebmailBlockedError` (with the reason) unless the control plane lets `address` use the webmail now. */
  async #assertAllowed(address: string): Promise<void> {
    const access = await this.#d.access.state(address);
    if (access !== "ok") throw new WebmailBlockedError("mailbox unavailable", access);
  }

  /**
   * Why a sign-in Stalwart refused may really be a blocked mailbox: the mail server disables a suspended account's
   * sign-in, so its right password is refused like a wrong one. Only for callers that already know this browser signed
   * in to `address` before (docs/internal/07-security.md "Webmail sign-in and suspension"): the control-plane reason,
   * or null when the mailbox may be used (then the refusal really was the password).
   */
  async blockedReason(address: string): Promise<WebmailRefusal | null> {
    const access = await this.#d.access.state(address);
    return access === "ok" ? null : access;
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
    return this.#mailboxFor(tokens);
  }

  /** The mailbox behind fresh tokens (its JMAP session), once the control plane lets it use the webmail. */
  async #mailboxFor(tokens: OAuthTokens): Promise<MailboxTokens> {
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
    await this.#assertAllowed(s.username);
    return {
      username: s.username,
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  }

  /**
   * The console → webmail handoff (ADR-0024), called by the core redemption once it has checked the person, the
   * console session, the browser and the mailbox: signs in with a throwaway credential (minted, used once and
   * destroyed by `handoffSignIn`) and starts an ordinary webmail session. The mail server must name exactly the
   * mailbox the control plane chose; anything else is dropped. No password is involved anywhere.
   */
  async openHandoff(target: {
    address: string;
    externalId: string;
    console: { userId: string; sessionId: string };
  }): Promise<{
    sessionId: string;
    session: WebmailSession;
  }> {
    const signIn = this.#d.handoffSignIn;
    if (!signIn) throw new WebmailUnavailableError("handoff not configured");
    let tokens: OAuthTokens;
    try {
      tokens = await signIn({ address: target.address, externalId: target.externalId });
    } catch (err) {
      if (err instanceof WebmailBusyError) throw err;
      // Our own fresh credential refused, or the mail server unreachable: never the person's fault.
      log.warn("webmail handoff: sign-in failed", { component: "webmail", err });
      throw new WebmailUnavailableError("mail server unavailable");
    }
    const mailbox = await this.#mailboxFor(tokens);
    if (mailbox.username.toLowerCase() !== target.address.toLowerCase()) {
      log.warn("webmail handoff: mail server named another mailbox", { component: "webmail" });
      throw new WebmailUnavailableError("mail server named another mailbox");
    }
    const session: WebmailSession = { ...mailbox, createdAt: this.#d.now(), console: target.console };
    const sessionId = await this.#d.store.create(session);
    return { sessionId, session };
  }

  /**
   * True when this webmail session came from the console handoff and that console session no longer exists (signed
   * out, revoked, "sign out everywhere", a password reset): the webmail session must end with it. A failed check
   * counts as ended (fail closed).
   */
  async consoleEnded(s: WebmailSession): Promise<boolean> {
    if (!s.console) return false;
    const check = this.#d.consoleSessionAlive;
    if (!check) return true;
    const key = `${s.console.userId} ${s.console.sessionId}`;
    const until = this.#consoleAlive.get(key);
    if (until !== undefined && until > this.#d.now()) return false;
    let alive = false;
    try {
      alive = await check(s.console.userId, s.console.sessionId);
    } catch (err) {
      log.warn("webmail: console session check failed", { component: "webmail", err });
    }
    if (alive) this.#consoleAlive.set(key, this.#d.now() + 30_000);
    else this.#consoleAlive.delete(key);
    return !alive;
  }

  /** Signs in with the mailbox address and password (used once here, never stored or logged). */
  async signIn(address: string, password: string): Promise<{ sessionId: string; session: WebmailSession }> {
    const session: WebmailSession = { ...(await this.#authenticate(address, password)), createdAt: this.#d.now() };
    const sessionId = await this.#d.store.create(session);
    return { sessionId, session };
  }

  /**
   * Checks a mailbox password with the mail server (a sign-in whose tokens are dropped at once): before a password
   * change, so a session cookie alone can't change the password. Wrong password → `WebmailSignInError`; throttling →
   * `WebmailBusyError`; anything else → `WebmailUnavailableError`. The password is used once, never kept or logged.
   */
  async checkPassword(address: string, password: string): Promise<void> {
    try {
      await this.#d.oauth.signIn(address, password);
    } catch (err) {
      if (err instanceof GrantRefusedError) throw new WebmailSignInError("sign-in refused");
      if (err instanceof WebmailBusyError) throw err;
      log.warn("webmail password check: Stalwart unavailable", { component: "webmail", err });
      throw new WebmailUnavailableError("mail server unavailable");
    }
  }

  /**
   * After the mailbox's password changed (the mail server revoked every token it had issued): signs `address` in
   * again with the new password and moves this session to a **new session id** with the fresh tokens (the old id is
   * deleted, so a copied cookie stops working too), keeping its other mailboxes and its absolute lifetime. The person
   * who changed it stays signed in; every other session of that mailbox ends. Returns the new session id.
   */
  async renewMailbox(sessionId: string, address: string, password: string): Promise<string> {
    const fresh = await this.#authenticate(address, password);
    const cur = await this.#d.store.read(sessionId);
    if (!cur) throw new WebmailSignedOutError("signed out");
    const { version: _version, ...rest } = cur;
    const next: WebmailSession =
      rest.username === fresh.username
        ? { ...rest, ...fresh }
        : { ...rest, others: (rest.others ?? []).map((m) => (m.username === fresh.username ? fresh : m)) };
    const newId = await this.#d.store.create(next);
    this.#forgetRefresh(sessionId);
    await this.#d.store.destroy(sessionId);
    return newId;
  }

  /**
   * The mailboxes of this session: the active one, the session's own others, and every mailbox shared with its people
   * now (auto-mapping, ADR-0026 §6: "Shared with you"; no tokens are minted for listing). Opened delegated entries
   * whose grant is gone are dropped from the session here too.
   */
  async mailboxes(sessionId: string): Promise<MailboxList | null> {
    const s = await this.#sessionOrOwn(sessionId);
    if (!s) return null;
    const own = ownEntries(s).map((m) => m.username);
    const opened = delegatedEntries(s);
    let shared: DelegatedMailbox[] = [];
    if (this.#d.delegation) {
      try {
        shared = await this.#d.delegation.list(own);
      } catch (err) {
        // The list is a convenience; the gate still decides every use. Keep what the session holds, drop nothing.
        log.warn("webmail: delegated mailboxes not listed", { component: "webmail", err });
        return this.#list(s, [], opened);
      }
      // An entry stays while any right on its mailbox does (one opened to send from has a send right only); each use
      // is still checked for what it needs (reading needs full access, sending a send right).
      const keep = new Set(shared.map((m) => m.address));
      const gone = opened.filter((m) => !keep.has(m.username.toLowerCase()));
      if (gone.length > 0) {
        const next = await this.#dropDelegated(sessionId, new Set(gone.map((m) => m.username)));
        return this.#list(next, shared, delegatedEntries(next));
      }
    }
    return this.#list(s, shared, opened);
  }

  #list(s: WebmailSession, shared: DelegatedMailbox[], opened: MailboxTokens[]): MailboxList {
    const isOpen = new Set(opened.map((m) => m.username.toLowerCase()));
    return {
      active: s.username,
      activeShared: s.delegated !== undefined,
      others: (s.others ?? []).filter((m) => !m.delegated).map((m) => m.username),
      shared: shared.map((m) => ({
        address: m.address,
        via: m.via,
        fullAccess: m.rights.includes("full_access"),
        sendAs: m.rights.includes("send_as"),
        sendOnBehalf: m.rights.includes("send_on_behalf"),
        open: isOpen.has(m.address),
      })),
    };
  }

  /**
   * Signs another mailbox in to the same session ("Add another mailbox") and makes it active. Signing in to one
   * that is already there just renews its tokens. At most `MAX_MAILBOXES` of the session's own per session.
   */
  async addMailbox(sessionId: string, address: string, password: string): Promise<WebmailSession> {
    if (!(await this.#sessionOrOwn(sessionId))) throw new WebmailSignedOutError("signed out");
    const added = await this.#authenticate(address, password);
    return this.#update(sessionId, (current) => {
      const { others = [], createdAt, version, console: bound, ...active } = current;
      const rest = [active, ...others].filter((m) => m.username !== added.username);
      if (rest.filter((m) => !m.delegated).length + 1 > MAX_MAILBOXES) {
        throw new WebmailRefusedError(`You can have ${String(MAX_MAILBOXES)} mailboxes open at once.`);
      }
      // The console binding belongs to the whole session, whichever mailbox is active (ADR-0024).
      return { ...added, createdAt, version, ...(bound ? { console: bound } : {}), others: rest };
    });
  }

  /**
   * Makes another mailbox of this session the active one: one of its own, or a delegated one already opened (checked
   * against the grant first; refused → dropped, 404). Unknown addresses are refused.
   */
  async switchMailbox(sessionId: string, username: string): Promise<WebmailSession> {
    const current = await this.#sessionOrOwn(sessionId);
    if (!current) throw new WebmailSignedOutError("signed out");
    // Addresses compare case-insensitively: the stored and requested forms may differ only in case.
    const wanted = username.toLowerCase();
    if (current.username.toLowerCase() === wanted) return current;
    const target = (current.others ?? []).find((m) => m.username.toLowerCase() === wanted);
    if (!target) throw new WebmailRefusedError("That mailbox isn't signed in here.");
    if (target.delegated) {
      if (!(await this.#delegatedOk(sessionId, current, target))) {
        await this.#dropDelegated(sessionId, new Set([target.username]));
        throw new WebmailDelegationRefusedError("not granted");
      }
    } else if ((await this.#d.access.state(target.username)) !== "ok") {
      // That one is suspended or gone: drop it (and what was opened through it), keep the session on the current one.
      await this.#update(sessionId, (cur) => ({
        ...cur,
        others: (cur.others ?? []).filter((m) => m.username !== username && m.delegated?.via !== username),
      }));
      throw new WebmailRefusedError("This mailbox can't be used right now.");
    }
    return this.#update(sessionId, (cur) => {
      const { others = [], createdAt, version, console: bound, ...active } = cur;
      const t = others.find((m) => m.username === username);
      if (!t) throw new WebmailRefusedError("That mailbox isn't signed in here.");
      return {
        ...t,
        createdAt,
        version,
        ...(bound ? { console: bound } : {}),
        others: [active, ...others.filter((m) => m !== t)],
      };
    });
  }

  /**
   * Opens a mailbox shared with the person (ADR-0026 §6: a "Shared with you" entry, or **Open another mailbox** by
   * address) and makes it active. Already open → switched to; one of the session's own → switched to. Otherwise core
   * `openDelegatedMailbox` checks the grant now, mints a throwaway credential, exchanges it once and destroys it, and
   * audits it; the tokens are sealed into this session only. Every refusal is the same 404.
   */
  async openDelegated(
    sessionId: string,
    address: string,
    req: RequestMeta,
    opts: { activate?: boolean } = {},
  ): Promise<WebmailSession> {
    const s = await this.#sessionOrOwn(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    const want = address.trim().toLowerCase();
    const already = [s, ...(s.others ?? [])].find((m) => m.username.toLowerCase() === want);
    if (opts.activate === false) {
      // For a mailbox-scoped tab (`pin.ts`): opened (or checked, if open already) without switching what the session's
      // other tabs show. The tab then pins it on every request. The person's own mailboxes are never opened this way.
      if (already && !already.delegated) throw new WebmailDelegationRefusedError("own mailbox");
      if (already) {
        // Not dropped when refused: an entry opened to send from (a send right only) stays for its undo hold; the
        // list drops entries with no right left.
        if (!(await this.#delegatedOk(sessionId, s, already))) throw new WebmailDelegationRefusedError("not granted");
        // Read and manage checked just now: the entry may be pinned to a tab from here on (`pin.ts`).
        if (already.delegated?.opened === "full_access") return s;
        return this.#update(sessionId, (cur) => {
          const mark = (m: MailboxTokens): MailboxTokens =>
            m.delegated && m.username === already.username
              ? { ...m, delegated: { ...m.delegated, opened: "full_access" } }
              : m;
          return { ...cur, ...mark(cur), others: (cur.others ?? []).map(mark) };
        });
      }
      await this.#openEntry(sessionId, s, want, "full_access", req);
      return (await this.#d.store.read(sessionId)) ?? s;
    }
    if (already) return this.switchMailbox(sessionId, already.username);
    const entry = await this.#openEntry(sessionId, s, want, "full_access", req);
    return this.#update(sessionId, (cur) => {
      // Opened (and made active) by a concurrent request meanwhile: already where it should be.
      if (cur.delegated && cur.username.toLowerCase() === entry.username.toLowerCase()) return cur;
      const { others = [], createdAt, version, console: bound, ...active } = cur;
      const t = others.find((m) => m.delegated && m.username.toLowerCase() === entry.username.toLowerCase());
      if (!t) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
      return {
        ...t,
        createdAt,
        version,
        ...(bound ? { console: bound } : {}),
        others: [active, ...others.filter((m) => m !== t)],
      };
    });
  }

  /**
   * Mints a delegated entry for `want` (core `openDelegatedMailbox` with `need`: audited, the grant checked now) and
   * seals it into the session's others, without making it active. Refused when the session's own sign-ins no longer
   * hold, at the per-person cap, or when the mailbox it came through left the session meanwhile.
   */
  async #openEntry(
    sessionId: string,
    s: WebmailSession,
    want: string,
    need: DelegationNeed,
    req: RequestMeta,
  ): Promise<MailboxTokens> {
    const delegation = this.#d.delegation;
    const signIn = this.#d.handoffSignIn;
    if (!delegation || !signIn) throw new WebmailDelegationRefusedError("delegation not configured");
    const tooMany = () =>
      new WebmailRefusedError(
        `You can have ${String(DELEGATED_MAILBOXES_PER_PERSON)} shared mailboxes open at once. Sign out and in again to start over.`,
      );
    // Before minting (no credential for an open that can't be kept), and again in the write below.
    if (delegatedEntries(s).length >= DELEGATED_MAILBOXES_PER_PERSON) throw tooMany();
    // Every own sign-in the open may go through must still hold at the mail server, checked now (not cached).
    for (const own of ownEntries(s)) await this.#proveOwn(sessionId, s, own.username.toLowerCase(), true);
    const { value, mailbox } = await delegation.open(
      { owners: ownEntries(s).map((m) => m.username), address: want, console: s.console ?? null, need },
      async (target) => {
        let tokens: OAuthTokens;
        try {
          tokens = await signIn({ address: target.address, externalId: target.externalId });
        } catch (err) {
          if (err instanceof WebmailBusyError || err instanceof CredentialSlotTakenError) {
            throw err;
          }
          log.warn("webmail delegated open: sign-in failed", { component: "webmail", err });
          throw new WebmailUnavailableError("mail server unavailable");
        }
        try {
          return await this.#mailboxFor(tokens);
        } catch (err) {
          // Checked a moment ago by the open itself; never end the delegate's own session over it.
          if (err instanceof WebmailBlockedError) throw new WebmailUnavailableError("mailbox unavailable");
          throw err;
        }
      },
      req,
    );
    const entry: MailboxTokens = {
      ...value,
      delegated: {
        mailboxId: mailbox.mailboxId,
        granteeUserId: mailbox.granteeUserId,
        via: mailbox.via,
        opened: need === "full_access" ? "full_access" : "send",
      },
    };
    await this.#update(sessionId, (cur) => {
      const { others = [] } = cur;
      const all = [cur, ...others];
      if (!all.some((m) => !m.delegated && m.username.toLowerCase() === mailbox.via)) {
        throw new WebmailRefusedError("Your active mailbox changed. Try again.");
      }
      // The active entry is this mailbox already (a concurrent open): keep that one.
      if (cur.username.toLowerCase() === entry.username.toLowerCase()) return cur;
      const rest = others.filter((m) => m.username.toLowerCase() !== entry.username.toLowerCase());
      // Counted again on the record being written: concurrent opens can't pass the cap together.
      if ([cur, ...rest].filter((m) => m.delegated).length >= DELEGATED_MAILBOXES_PER_PERSON) throw tooMany();
      return { ...cur, others: [...rest, entry] };
    });
    return entry;
  }

  /** The gate key for a session: a hash of its id (never the id itself). */
  #gateKey(sessionId: string): string {
    return createHash("sha256").update(`delegation\0${sessionId}`).digest("base64url").slice(0, 22);
  }

  /**
   * Whether a delegated entry of this session may be used now for `need` (reading and managing unless said): the
   * mailbox it came through is still one of the session's own and still signs in, and core's `DelegationGate` says
   * yes. Failures throw (unavailable, nothing dropped).
   */
  async #delegatedOk(
    sessionId: string,
    s: WebmailSession,
    entry: MailboxTokens,
    need: DelegationNeed = "full_access",
  ): Promise<boolean> {
    const d = entry.delegated;
    const gate = this.#d.delegation?.gate;
    if (!d || !gate) return false;
    if (!ownEntries(s).some((m) => m.username.toLowerCase() === d.via)) return false;
    // The person's own sign-in must still hold at the mail server (a password reset ends it), not only in our records.
    await this.#proveOwn(sessionId, s, d.via);
    try {
      return await gate.allowed(this.#gateKey(sessionId), {
        mailboxId: d.mailboxId,
        granteeUserId: d.granteeUserId,
        via: d.via,
        need,
        console: s.console ?? null,
      });
    } catch (err) {
      log.warn("webmail: delegation check failed", { component: "webmail", err });
      throw new WebmailUnavailableError("delegation check unavailable");
    }
  }

  /**
   * Proves the session's own mailbox `via` against the mail server: its JMAP session answers with its token (refreshed
   * if due), naming that mailbox. Checked at most every `VIA_PROOF_MS` (10 s, like the gate's cache) unless `force`.
   * A refused token or refresh (its password was reset or changed, or the account was disabled) ends the **whole**
   * session (ADR-0026 §6: delegated access rides on the person's own sign-in), as does a mail server naming another
   * mailbox. Anything else is "unavailable" (nothing ended).
   */
  async #proveOwn(sessionId: string, s: WebmailSession, via: string, force = false): Promise<void> {
    const key = `${this.#gateKey(sessionId)}\0${via}`;
    const now = this.#d.now();
    const until = this.#viaProven.get(key);
    if (!force && until !== undefined && until > now) return;
    const own = ownEntries(s).find((m) => m.username.toLowerCase() === via);
    if (!own) throw new WebmailDelegationRefusedError("own mailbox not signed in");
    const end = async (why: string): Promise<never> => {
      this.#viaProven.delete(key);
      this.#forgetRefresh(sessionId);
      this.#d.delegation?.gate.forget(this.#gateKey(sessionId));
      await this.#d.store.destroy(sessionId);
      throw new WebmailSignedOutError(why);
    };
    let token = own.accessToken;
    let refreshed = false;
    /**
     * A refresh of that own entry, shared with `session()`'s (the same `#refreshing` key: session, no pin, entry), so
     * one refresh token is never used twice at once — a shared tab's reads prove the own mailbox while its compose
     * requests, pinned to it, may be refreshing it. One already in flight is awaited and its tokens used.
     */
    const refresh = async (): Promise<boolean> => {
      if (refreshed) return false;
      refreshed = true;
      const refreshKey = `${sessionId}\0\0${own.username}`;
      const pending = this.#refreshing.get(refreshKey);
      if (pending) {
        if ((await pending) === null) throw new WebmailSignedOutError("signed out");
        const cur = await withPinnedMailbox(null, () => this.#d.store.read(sessionId));
        const after = cur ? ownEntries(cur).find((m) => m.username === own.username) : undefined;
        if (!after) throw new WebmailSignedOutError("signed out");
        if (after.accessToken === token) return false;
        token = after.accessToken;
        return true;
      }
      const used = own.refreshToken;
      if (!used) return false;
      const run = (async (): Promise<WebmailSession | null> => {
        let fresh: OAuthTokens;
        try {
          fresh = await this.#d.oauth.refresh(used);
        } catch (err) {
          if (err instanceof GrantRefusedError) return end("own mailbox token revoked");
          log.warn("webmail: own mailbox refresh failed", { component: "webmail", err });
          throw new WebmailUnavailableError("mail server unavailable");
        }
        token = fresh.accessToken;
        // Kept only over the tokens this refresh replaced: a concurrent change wins (it refreshes again on its use).
        // Written unpinned (the swap matches the entry itself), so a pinned entry dropped meanwhile can't lose them.
        return withPinnedMailbox(null, () =>
          this.#update(sessionId, (cur) => {
            const swap = (m: MailboxTokens): MailboxTokens =>
              !m.delegated && m.username === own.username && m.refreshToken === used
                ? { ...m, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt }
                : m;
            return { ...cur, ...swap(cur), others: (cur.others ?? []).map(swap) };
          }),
        ).catch((err: unknown): WebmailSession | null => {
          if (err instanceof WebmailSignedOutError) return null;
          log.warn("webmail: refreshed own tokens not kept", { component: "webmail", err });
          return s;
        });
      })();
      this.#refreshing.set(refreshKey, run);
      try {
        await run;
      } finally {
        if (this.#refreshing.get(refreshKey) === run) this.#refreshing.delete(refreshKey);
      }
      return true;
    };
    if (own.expiresAt - now <= this.#d.refreshSkewMs) await refresh();
    let res = await this.#upstream(`${this.#base}/jmap/session`, { headers: this.#auth(token) });
    if (res.status === 401 && (await refresh())) {
      await res.body?.cancel();
      res = await this.#upstream(`${this.#base}/jmap/session`, { headers: this.#auth(token) });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return end("own mailbox signed out");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new WebmailUnavailableError("mail server unavailable");
    }
    const body = (await res.json().catch(() => null)) as { username?: unknown } | null;
    if (typeof body?.username !== "string" || body.username.toLowerCase() !== via) return end("own mailbox changed");
    if (this.#viaProven.size > 10_000) this.#viaProven.clear();
    this.#viaProven.set(key, now + VIA_PROOF_MS);
  }

  /** For `route()`'s gate: whether the session's active delegated entry may still be used (true when not delegated). */
  async delegatedActiveAllowed(sessionId: string, s: WebmailSession): Promise<boolean> {
    return s.delegated ? this.#delegatedOk(sessionId, s, s) : true;
  }

  /**
   * Drops delegated entries from the session (their grant is gone): an active one hands over to the mailbox it came
   * through (or the first own one). Returns the session as written.
   */
  async dropDelegated(sessionId: string, usernames: ReadonlySet<string>): Promise<WebmailSession> {
    return this.#dropDelegated(sessionId, usernames);
  }

  async #dropDelegated(sessionId: string, usernames: ReadonlySet<string>): Promise<WebmailSession> {
    this.#d.delegation?.gate.forget(this.#gateKey(sessionId));
    // A request pinned to a tab never drops an entry (a link could otherwise end another tab's send and its undo):
    // it is refused instead, and the entry goes on the session's own next use or listing.
    if (pinnedAddress() !== null) {
      const s = await withPinnedMailbox(null, () => this.#d.store.read(sessionId));
      if (!s) throw new WebmailSignedOutError("signed out");
      return s;
    }
    return this.#update(sessionId, (cur) => {
      const { others = [], createdAt, version, console: bound, ...active } = cur;
      const all = [active, ...others].filter((m) => !(m.delegated && usernames.has(m.username)));
      const stays = all.includes(active);
      const keep = stays
        ? active
        : (all.find((m) => !m.delegated && m.username.toLowerCase() === active.delegated?.via) ??
          all.find((m) => !m.delegated));
      if (!keep) throw new WebmailSignedOutError("signed out");
      return {
        ...keep,
        createdAt,
        version,
        ...(bound ? { console: bound } : {}),
        others: all.filter((m) => m !== keep),
      };
    });
  }

  /**
   * `session()`, except that a delegated active entry whose grant is gone (dropped, 404) leaves the session on the
   * person's own mailbox: for listing and switching, which must keep working after a revoke.
   */
  async #sessionOrOwn(sessionId: string): Promise<WebmailSession | null> {
    try {
      return await this.session(sessionId);
    } catch (err) {
      if (err instanceof WebmailDelegationRefusedError) return this.session(sessionId);
      throw err;
    }
  }

  /** The active mailbox, refusing a delegated one: for what only the person's own mailbox may do. */
  async #ownActive(sessionId: string): Promise<WebmailSession> {
    const s = await this.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    if (s.delegated) throw new WebmailOwnMailboxOnlyError("own mailbox only");
    return s;
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
    this.#forgetRefresh(sessionId);
    await this.#d.store.destroy(sessionId);
  }

  /**
   * A usable session (refreshed when close to expiry), or null when signed out. Every use re-checks the control
   * plane: a suspended or deleted mailbox ends the session (`WebmailBlockedError`).
   */
  async session(sessionId: string, opts: { forceRefresh?: boolean } = {}): Promise<WebmailSession | null> {
    const s = await this.#d.store.read(sessionId);
    if (!s) return null;
    if (await this.consoleEnded(s)) {
      this.#forgetRefresh(sessionId);
      await this.#d.store.destroy(sessionId);
      return null;
    }
    // The session's own mailbox decides whether the session goes on (a delegated active entry is the gate's).
    const access = await this.#d.access.state(s.delegated?.via ?? s.username);
    if (access !== "ok") {
      this.#forgetRefresh(sessionId);
      await this.#d.store.destroy(sessionId);
      throw new WebmailBlockedError("mailbox unavailable", access);
    }
    // A delegated mailbox: the grant now, before any use or refresh of its token (ADR-0026 §6).
    if (s.delegated && !(await this.#delegatedOk(sessionId, s, s))) {
      this.#forgetRefresh(sessionId);
      await this.#dropDelegated(sessionId, new Set([s.username]));
      throw new WebmailDelegationRefusedError("not granted");
    }
    if (!opts.forceRefresh && s.expiresAt - this.#d.now() > this.#d.refreshSkewMs) return s;
    // One refresh per session, entry and shared pin: a request pinned to a shared mailbox refreshes that delegated
    // entry under its own key. An own entry has one key whatever the pin (none, or an own pin: a mailbox-scoped tab's
    // compose requests), the same one `#proveOwn` uses, so its refresh token is never used twice at once; whoever
    // waits re-reads the session as its own request sees it.
    const key = `${sessionId}\0${pinnedKind() === "own" ? "" : (pinnedAddress() ?? "")}\0${s.username}`;
    const pending = this.#refreshing.get(key);
    // Another request's refresh of this entry: wait for it, then read the session as this request sees it.
    if (pending) return (await pending) === null ? null : this.#d.store.read(sessionId);
    const p: Promise<WebmailSession | null> = this.#refresh(sessionId, s).finally(() => {
      // Only this refresh's own entry (a sign-out may have cleared it and another refresh taken the key since).
      if (this.#refreshing.get(key) === p) this.#refreshing.delete(key);
    });
    this.#refreshing.set(key, p);
    return p;
  }

  /** Forgets the session's refreshes in flight (signed out or ended). */
  #forgetRefresh(sessionId: string): void {
    for (const key of this.#refreshing.keys()) if (key.startsWith(`${sessionId}\0`)) this.#refreshing.delete(key);
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
      // Another write landed in between (another entry's refresh, a tab's change): the new tokens still go into this
      // entry if it still holds the refresh token just used, else a refresh token already spent would be kept and
      // used again (refused, ending the session). A concurrent change of this entry itself wins.
      const used = s.refreshToken;
      const delegated = s.delegated !== undefined;
      const swap = (m: MailboxTokens): MailboxTokens =>
        m.username === s.username && (m.delegated !== undefined) === delegated && m.refreshToken === used
          ? { ...m, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }
          : m;
      try {
        // Unpinned (the swap matches the entry itself): a pinned entry dropped meanwhile can't make it fail.
        await withPinnedMailbox(null, () =>
          this.#update(sessionId, (cur) => ({ ...cur, ...swap(cur), others: (cur.others ?? []).map(swap) })),
        );
      } catch (err) {
        if (!(err instanceof WebmailSignedOutError) && !(err instanceof WebmailBusyError)) throw err;
      }
      return await this.#d.store.read(sessionId);
    } catch (err) {
      if (err instanceof GrantRefusedError) {
        // A delegated mailbox's password changed: that entry goes, the person's own session stays.
        if (s.delegated) {
          await this.#dropDelegated(sessionId, new Set([s.username]));
          throw new WebmailDelegationRefusedError("token revoked");
        }
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
    access: Access = OWN,
  ): Promise<{ session: WebmailSession; value: T }> {
    let s = await this.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = s;
      // Decided on the very entry whose token is used: a mailbox shared with the person only for reading and managing
      // (ADR-0026 §6), however the active mailbox changed since the route's gate looked.
      if (current.delegated && access !== READ) throw new WebmailOwnMailboxOnlyError("own mailbox only");
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
        if (current.delegated) {
          await this.#dropDelegated(sessionId, new Set([current.username]));
          throw new WebmailDelegationRefusedError("mailbox unavailable");
        }
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
    if (s.delegated) {
      await this.#dropDelegated(sessionId, new Set([s.username]));
      throw new WebmailDelegationRefusedError("token refused");
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
    const { value } = await this.#withSession(
      sessionId,
      async (s) => {
        const res = await this.#upstream(`${this.#base}/jmap/`, {
          method: "POST",
          headers: { ...this.#auth(s.accessToken), "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
        const json: unknown = await res.json().catch(() => null);
        return {
          status: res.status,
          limited: isLimitError(res.status, json),
          value: { status: res.status, body: json },
        };
      },
      READ,
    );
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
    const res = await this.jmapAs(
      sessionId,
      (s) => {
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
      },
      READ,
    );
    const resp = res as { methodResponses?: [string, { list?: JmapEmail[] }, string][] } | null;
    const [name, args] = resp?.methodResponses?.[0] ?? [];
    if (name !== "Email/get") throw new WebmailUnavailableError("unexpected response");
    const email = args?.list?.[0];
    if (!email) return null;
    return this.#view(sessionId, accountId, email, sanitize, toText);
  }

  /** A message's raw header fields in order (for the trusted Authentication-Results); empty when it's gone. */
  async headers(sessionId: string, emailId: string): Promise<{ name: string; value: string }[]> {
    const res = await this.jmapAs(
      sessionId,
      (s) => ({
        using: USING,
        methodCalls: [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["headers"] }, "h"]],
      }),
      READ,
    );
    const resp = res as { methodResponses?: [string, { list?: { headers?: unknown }[] }, string][] } | null;
    const [name, args] = resp?.methodResponses?.[0] ?? [];
    if (name !== "Email/get") throw new WebmailUnavailableError("unexpected response");
    const list = args?.list?.[0]?.headers;
    if (!Array.isArray(list)) return [];
    return list.flatMap((h: unknown) => {
      if (typeof h !== "object" || h === null) return [];
      const { name: n, value } = h as { name?: unknown; value?: unknown };
      return typeof n === "string" && typeof value === "string" ? [{ name: n, value: value.trim() }] : [];
    });
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
      const res = await this.download(sessionId, accountId, part.blobId, "part", READ);
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
      const blob = await this.download(sessionId, accountId, part.blobId, "inline", READ);
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
    const r = await this.#call(
      sessionId,
      (s) => {
        accountId = s.accountId;
        return [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["attachments"] }, "g"]];
      },
      USING,
      undefined,
      { access: READ },
    );
    const parent = ((r.get("g")?.list ?? []) as { attachments: BodyPart[] | null }[])[0];
    const part = parent?.attachments?.find((p) => p.blobId === blobId && /^message\/rfc822$/i.test(p.type));
    if (!part) return null;
    const parsed = await this.#call(
      sessionId,
      (s) => [
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
      ],
      USING,
      undefined,
      { access: READ },
    );
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
    const r = await this.#call(
      sessionId,
      (s) => {
        accountId = s.accountId;
        return [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["blobId", "size"] }, "g"]];
      },
      USING,
      undefined,
      { access: READ },
    );
    const e = ((r.get("g")?.list ?? []) as { blobId: string; size: number }[])[0];
    if (!e) return null;
    return this.download(sessionId, accountId, e.blobId, "message.eml", READ);
  }

  /**
   * "Show original": the message's summary fields and its source as text (first `maxBytes`), or null when the id
   * isn't a message of the signed-in mailbox. The source is read in full only up to the cap; the rest is cancelled.
   */
  async original(sessionId: string, emailId: string, maxBytes: number): Promise<OriginalMessage | null> {
    let accountId = "";
    const r = await this.#call(
      sessionId,
      (s) => {
        accountId = s.accountId;
        return [
          [
            "Email/get",
            {
              accountId: s.accountId,
              ids: [emailId],
              properties: ["blobId", "size", "receivedAt", "sentAt", "messageId", "from", "to", "cc", "subject"],
            },
            "g",
          ],
        ];
      },
      USING,
      undefined,
      { access: READ },
    );
    const e = (
      (r.get("g")?.list ?? []) as {
        blobId: string;
        size: number;
        receivedAt: string | null;
        sentAt: string | null;
        messageId: string[] | null;
        from: Address[] | null;
        to: Address[] | null;
        cc: Address[] | null;
        subject: string | null;
      }[]
    )[0];
    if (!e) return null;
    const res = await this.download(sessionId, accountId, e.blobId, "message.eml", READ);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cut = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= maxBytes) {
        cut = size > maxBytes || e.size > maxBytes;
        await reader.cancel();
        break;
      }
    }
    const text = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
    return {
      id: emailId,
      messageId: e.messageId?.[0] ?? null,
      receivedAt: e.receivedAt,
      sentAt: e.sentAt,
      from: e.from ?? [],
      to: e.to ?? [],
      cc: e.cc ?? [],
      subject: e.subject ?? "",
      size: e.size,
      text,
      cut,
    };
  }

  /** Server-built JMAP request for the signed-in account (no allow-list: the BFF wrote it). */
  async jmapAs(
    sessionId: string,
    build: (s: WebmailSession) => JmapRequestBody,
    access: Access = OWN,
  ): Promise<unknown> {
    const { value } = await this.#withSession(
      sessionId,
      async (s) => {
        const res = await this.#upstream(`${this.#base}/jmap/`, {
          method: "POST",
          headers: { ...this.#auth(s.accessToken), "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(build(s)),
        });
        const json: unknown = await res.json().catch(() => null);
        return {
          status: res.status,
          limited: isLimitError(res.status, json),
          value: { status: res.status, body: json },
        };
      },
      access,
    );
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
  async download(
    sessionId: string,
    accountId: string,
    blobId: string,
    name: string,
    access: Access = OWN,
  ): Promise<Response> {
    const { value } = await this.#withSession(
      sessionId,
      async (s) => {
        if (s.accountId !== accountId)
          return { status: 404, limited: false, value: new Response(null, { status: 404 }) };
        const url = `${this.#base}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(name)}?accept=application%2Foctet-stream`;
        const res = await this.#upstream(url, { headers: this.#auth(s.accessToken) });
        if (res.status === 401 || res.status === 403 || res.status === 429) await res.body?.cancel();
        return { status: res.status, limited: res.status === 429, value: res };
      },
      access,
    );
    return value;
  }

  /** Runs server-built calls and returns responses by call id; a method error is "unavailable". */
  async #call(
    sessionId: string,
    build: (s: WebmailSession) => [string, Record<string, unknown>, string][],
    using: string[] = USING,
    /** Refuse if the active mailbox is no longer this account (it was switched during a multi-step action). */
    expectAccount?: string,
    /**
     * Server-internal follow-ups of something that account already did (auto-saving the recipients of a send after
     * the undo hold): if the person switched mailbox meanwhile, act on `expectAccount` with its own tokens (it's still
     * signed in to this session) instead of refusing.
     */
    opts: { inactive?: boolean; access?: Access } = {},
  ): Promise<Map<string, Record<string, unknown>>> {
    if (opts.inactive && expectAccount !== undefined) {
      const current = await this.session(sessionId);
      if (current && current.accountId !== expectAccount) {
        return this.#callOther(current, expectAccount, build, using);
      }
    }
    const res = (await this.jmapAs(
      sessionId,
      (s) => {
        if (expectAccount !== undefined && s.accountId !== expectAccount) {
          throw new WebmailRefusedError("Your active mailbox changed. Try again.");
        }
        // Belt and braces where the token is picked: contacts, submission and quota are never a shared mailbox's.
        if (s.delegated && using.some((u) => OWN_ONLY_CAPABILITIES.has(u))) {
          throw new WebmailOwnMailboxOnlyError("own mailbox only");
        }
        return { using, methodCalls: build(s) };
      },
      opts.access ?? OWN,
    )) as {
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

  /**
   * Runs calls for a signed-in but not active mailbox of this session, with that mailbox's own tokens (refreshed in
   * memory if due; the stored record isn't rewritten, so a concurrent switch is never undone). Refused when it's no
   * longer signed in here, or the control plane blocks it.
   */
  async #callOther(
    session: WebmailSession,
    account: string,
    build: (s: WebmailSession) => [string, Record<string, unknown>, string][],
    using: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const t = (session.others ?? []).find((o) => o.accountId === account);
    if (!t) throw new WebmailRefusedError("That mailbox isn't signed in here any more.");
    // Server-internal follow-ups act only on the session's own mailboxes.
    if (t.delegated) throw new WebmailOwnMailboxOnlyError("own mailbox only");
    await this.#assertAllowed(t.username);
    let token = t.accessToken;
    if (t.expiresAt - this.#d.now() <= this.#d.refreshSkewMs && t.refreshToken) {
      try {
        token = (await this.#d.oauth.refresh(t.refreshToken)).accessToken;
      } catch (err) {
        if (err instanceof GrantRefusedError) throw new WebmailSignedOutError("signed out");
        throw err;
      }
    }
    const target: WebmailSession = { ...t, createdAt: session.createdAt };
    const result = await this.#d.queue.run(t.username, () =>
      withLimitRetry(
        async () => {
          const res = await this.#upstream(`${this.#base}/jmap/`, {
            method: "POST",
            headers: { ...this.#auth(token), "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ using, methodCalls: build(target) }),
          });
          const json: unknown = await res.json().catch(() => null);
          return isLimitError(res.status, json)
            ? { retry: true as const }
            : { retry: false as const, value: { status: res.status, body: json } };
        },
        this.#d.sleep ? { sleep: this.#d.sleep } : {},
      ),
    );
    if (result === null) throw new WebmailBusyError("busy");
    if (result.status === 401) throw new WebmailSignedOutError("signed out");
    if (result.status !== 200) throw new WebmailUnavailableError("mail server error");
    const out = new Map<string, Record<string, unknown>>();
    const body = result.body as { methodResponses?: [string, Record<string, unknown>, string][] } | null;
    for (const [name, args, id] of body?.methodResponses ?? []) {
      if (name === "error") throw new WebmailUnavailableError("mail server error");
      if (!out.has(id)) out.set(id, args);
    }
    return out;
  }

  // ---- sending from a mailbox shared with the person (ADR-0026 §6 and §8, slice 13) ----------------------------
  //
  // A message is always submitted from the mailbox it says it is from, with that mailbox's own token, identity and
  // envelope sender, so its Sent copy lands in that mailbox and DKIM aligns (P5, P10). The person composes in their
  // own mailbox; at send time the draft is rebuilt in the shared one (attachments copied with the two tokens), and the
  // own draft is removed once the undo hold is over (undo hands it back). These are the only paths that use a
  // delegated entry's token for submission; `#withSession` and `#call` keep refusing it (default-deny).

  /**
   * The From picker (ADR-0026 §6): the active mailbox's own identities, then every mailbox shared with its person that
   * they may send from, as "desk@…" (send as) or "<their name> on behalf of desk@…" (send on behalf); send as wins
   * when both are held. Listing mints nothing; each send checks the right again.
   */
  async senders(sessionId: string): Promise<{ identities: Identity[]; shared: DelegatedSender[] }> {
    const s = await this.#ownActive(sessionId);
    const identities = await this.identities(sessionId);
    const delegation = this.#d.delegation;
    if (!delegation) return { identities, shared: [] };
    let list: DelegatedMailbox[];
    try {
      list = await delegation.list(ownEntries(s).map((m) => m.username));
    } catch (err) {
      // A convenience list; each send checks the grant itself.
      log.warn("webmail: delegated senders not listed", { component: "webmail", err });
      return { identities, shared: [] };
    }
    const me = s.username.toLowerCase();
    const own = identities.find((i) => i.email.toLowerCase() === me);
    const who = (own ? senderName(own) : null) ?? me;
    const shared = list.flatMap((m): DelegatedSender[] => {
      // Sent on behalf of a mailbox, the Sender is the active mailbox's person: only what comes through it.
      const mode = m.via === me ? sendMode(m.rights) : null;
      if (!mode) return [];
      return [{ mailbox: m.address, mode, label: mode === "send_as" ? m.address : `${who} on behalf of ${m.address}` }];
    });
    return { identities, shared };
  }

  /**
   * The session's delegated entry for `want`, usable for `need` now: the one already open, or one minted now (core
   * `openDelegatedMailbox`, audited; `beforeOpen` runs first, the route's fail-closed open limit). It must come through
   * the active own mailbox `via`. Refused (dropped, 404) when the gate says no.
   */
  async #delegatedFor(
    sessionId: string,
    via: string,
    want: string,
    need: DelegationNeed,
    req: RequestMeta,
    beforeOpen?: () => Promise<void>,
  ): Promise<MailboxTokens> {
    const read = async () => {
      const s = await this.#d.store.read(sessionId);
      if (!s) throw new WebmailSignedOutError("signed out");
      return s;
    };
    let s = await read();
    const find = (x: WebmailSession) =>
      [x, ...(x.others ?? [])].find((m) => m.delegated !== undefined && m.username.toLowerCase() === want);
    let entry = find(s);
    if (!entry) {
      if ([s, ...(s.others ?? [])].some((m) => m.username.toLowerCase() === want)) {
        throw new WebmailRefusedError("You can only send from your own addresses.");
      }
      await beforeOpen?.();
      await this.#openEntry(sessionId, s, want, need, req);
      s = await read();
      entry = find(s);
      if (!entry) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    }
    if (entry.delegated?.via !== via || !(await this.#delegatedOk(sessionId, s, entry, need))) {
      if (entry.delegated?.via === via) await this.#dropDelegated(sessionId, new Set([entry.username]));
      throw new WebmailDelegationRefusedError("not granted");
    }
    return entry;
  }

  /**
   * One request with a delegated entry's own token (not the active mailbox): refreshed first when due (and kept in the
   * session), retried once with a refreshed token on 401; a refused token or refresh, or the mail server's 403, drops
   * the entry (404). Only the send paths below call this, after the gate for a send right.
   */
  async #delegatedRequest<T>(
    sessionId: string,
    entry: MailboxTokens,
    send: (t: MailboxTokens) => Promise<{ status: number; limited: boolean; value: T }>,
  ): Promise<{ status: number; value: T }> {
    if (!entry.delegated) throw new WebmailOwnMailboxOnlyError("not a delegated entry");
    const drop = async (why: string): Promise<never> => {
      await this.#dropDelegated(sessionId, new Set([entry.username]));
      throw new WebmailDelegationRefusedError(why);
    };
    let tokens = entry;
    const refresh = async (): Promise<MailboxTokens> => {
      if (!tokens.refreshToken) return drop("no refresh token");
      let t: OAuthTokens;
      try {
        t = await this.#d.oauth.refresh(tokens.refreshToken);
      } catch (err) {
        if (err instanceof GrantRefusedError) return drop("token revoked");
        log.warn("webmail: delegated refresh failed", { component: "webmail", err });
        throw new WebmailUnavailableError("mail server unavailable");
      }
      const next: MailboxTokens = {
        ...tokens,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
      await this.#update(sessionId, (cur) => {
        const swap = (m: MailboxTokens): MailboxTokens =>
          m.delegated && m.username === entry.username
            ? { ...m, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt }
            : m;
        return { ...cur, ...swap(cur), others: (cur.others ?? []).map(swap) };
      }).catch((err: unknown) => {
        log.warn("webmail: refreshed delegated tokens not kept", { component: "webmail", err });
      });
      return next;
    };
    if (tokens.expiresAt - this.#d.now() <= this.#d.refreshSkewMs) tokens = await refresh();
    for (let attempt = 0; ; attempt++) {
      const current = tokens;
      let result: { status: number; value: T } | null;
      try {
        result = await this.#d.queue.run(entry.username, () =>
          withLimitRetry(
            async () => {
              const r = await send(current);
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
      if (result.status === 401 && attempt === 0) {
        tokens = await refresh();
        continue;
      }
      if (result.status === 401 || result.status === 403) return drop("mailbox refused the token");
      return result;
    }
  }

  /**
   * Server-built calls on a delegated entry (`#delegatedRequest`). Responses by call id, and by `<id>#<method>` for
   * every response (implicit ones, like the `Email/set` an `onSuccessDestroyEmail` makes, share their call's id).
   */
  async #callDelegated(
    sessionId: string,
    entry: MailboxTokens,
    build: (t: MailboxTokens) => [string, Record<string, unknown>, string][],
    using: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const { status, value } = await this.#delegatedRequest(sessionId, entry, async (t) => {
      const res = await this.#upstream(`${this.#base}/jmap/`, {
        method: "POST",
        headers: { ...this.#auth(t.accessToken), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ using, methodCalls: build(t) }),
      });
      const json: unknown = await res.json().catch(() => null);
      return { status: res.status, limited: isLimitError(res.status, json), value: json };
    });
    if (status !== 200) {
      log.warn("webmail upstream error", { component: "webmail", status });
      throw new WebmailUnavailableError("mail server error");
    }
    const out = new Map<string, Record<string, unknown>>();
    const body = value as { methodResponses?: [string, Record<string, unknown>, string][] } | null;
    for (const [name, args, id] of body?.methodResponses ?? []) {
      if (name === "error") {
        log.warn("webmail method error", { component: "webmail", type: String(args.type) });
        throw new WebmailUnavailableError("mail server error");
      }
      if (!out.has(id)) out.set(id, args);
      if (!out.has(`${id}#${name}`)) out.set(`${id}#${name}`, args);
    }
    return out;
  }

  /** Uploads bytes to a delegated entry's account (an attachment copied into it). */
  async #uploadDelegated(
    sessionId: string,
    entry: MailboxTokens,
    bytes: Uint8Array<ArrayBuffer>,
    type: string,
  ): Promise<string> {
    const { status, value } = await this.#delegatedRequest(sessionId, entry, async (t) => {
      const res = await this.#upstream(`${this.#base}/jmap/upload/${encodeURIComponent(t.accountId)}/`, {
        method: "POST",
        headers: { ...this.#auth(t.accessToken), "Content-Type": type },
        body: bytes,
      });
      const json: unknown = await res.json().catch(() => null);
      return { status: res.status, limited: isLimitError(res.status, json), value: json };
    });
    const blobId = (value as { blobId?: unknown } | null)?.blobId;
    if (status === 413) throw new WebmailRefusedError("That file is too large.");
    if (status >= 300 || typeof blobId !== "string") {
      log.warn("webmail upload failed", { component: "webmail", status });
      throw new WebmailUnavailableError("upload failed");
    }
    return blobId;
  }

  /** The person's own draft with everything rebuilding it needs; null when it isn't in this mailbox. */
  async #fullDraft(sessionId: string, draftId: string, account: string): Promise<FullDraft | null> {
    const r = await this.#call(
      sessionId,
      (x) => [
        [
          "Email/get",
          {
            accountId: x.accountId,
            ids: [draftId],
            properties: [
              "mailboxIds",
              "keywords",
              "from",
              "to",
              "cc",
              "bcc",
              "size",
              "subject",
              "inReplyTo",
              "references",
              "textBody",
              "htmlBody",
              "bodyValues",
              "attachments",
            ],
            bodyProperties: ["partId", "blobId", "type", "name", "size"],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes: MAX_FULL_BODY_BYTES,
          },
          "g",
        ],
      ],
      USING,
      account,
    );
    return ((r.get("g")?.list ?? []) as FullDraft[])[0] ?? null;
  }

  /**
   * The draft's structured fields again (what `draftEmail` builds a message from), with its attachments' blobs still
   * in the person's own account. Refused when a body is cut short or anything is out of the compose caps.
   */
  #rebuild(draft: FullDraft, identityId: string): DraftInput {
    const value = (parts: FullDraft["textBody"], type: string): string | undefined => {
      const part = (parts ?? []).find((p) => p.type.toLowerCase() === type);
      const v = part?.partId ? draft.bodyValues?.[part.partId] : undefined;
      if (v?.isTruncated === true) throw new WebmailRefusedError("This message is too large to send.");
      return v?.value;
    };
    const parsed = DraftInputSchema.safeParse({
      identityId,
      to: draft.to ?? [],
      cc: draft.cc ?? [],
      bcc: draft.bcc ?? [],
      subject: draft.subject ?? "",
      text: (value(draft.textBody, "text/plain") ?? "").slice(0, MAX_TEXT_CHARS),
      ...(value(draft.htmlBody, "text/html") === undefined ? {} : { html: value(draft.htmlBody, "text/html") }),
      ...(draft.inReplyTo?.length ? { inReplyTo: draft.inReplyTo } : {}),
      ...(draft.references?.length ? { references: draft.references } : {}),
      attachments: (draft.attachments ?? []).map((a) => ({
        blobId: a.blobId ?? "",
        name: a.name ?? "attachment",
        type: a.type,
        size: a.size,
      })),
    });
    if (!parsed.success) throw new WebmailRefusedError("This draft can't be sent from that mailbox.");
    const problem = draftProblem(parsed.data);
    if (problem) throw new WebmailRefusedError(problem.message);
    return parsed.data;
  }

  /** Copies the draft's attachments into the delegated mailbox (own token down, its token up), within the caps. */
  async #copyAttachments(
    sessionId: string,
    ownAccount: string,
    entry: MailboxTokens,
    list: DraftInput["attachments"],
  ): Promise<DraftInput["attachments"]> {
    if (list.length > MAX_ATTACHMENTS) throw new WebmailRefusedError("This message has too many attachments.");
    let total = 0;
    const out: DraftInput["attachments"] = [];
    for (const a of list) {
      const res = await this.download(sessionId, ownAccount, a.blobId, "attachment");
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new WebmailRefusedError("An attachment couldn't be read. Remove it and try again.");
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES || total + size > MAX_ATTACHMENT_BYTES) {
          await reader.cancel();
          throw new WebmailRefusedError("Attachments are too large for one message.");
        }
        chunks.push(value);
      }
      total += size;
      const bytes = new Uint8Array(new ArrayBuffer(size));
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const blobId = await this.#uploadDelegated(sessionId, entry, bytes, a.type);
      out.push({ ...a, blobId, size });
    }
    return out;
  }

  #heldKey(sessionId: string, mailbox: string, submissionId: string): string {
    return `${this.#gateKey(sessionId)}\0${mailbox}\0${submissionId}`;
  }

  /** Destroys emails in a delegated entry's account, retried once; true when the mail server confirmed every one. */
  async #destroyDelegated(sessionId: string, entry: MailboxTokens, ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.#callDelegated(
          sessionId,
          entry,
          (t) => [["Email/set", { accountId: t.accountId, destroy: ids }, "d"]],
          USING,
        );
        const destroyed = new Set((r.get("d")?.destroyed as string[] | undefined) ?? []);
        const notDestroyed = (r.get("d")?.notDestroyed as Record<string, { type?: string }> | undefined) ?? {};
        // Gone already counts as removed.
        if (ids.every((i) => destroyed.has(i) || notDestroyed[i]?.type === "notFound")) return true;
      } catch (err) {
        log.warn("webmail: delegated send copies not removed", { component: "webmail", err });
      }
    }
    return false;
  }

  /**
   * The copies of one delegated send in a mailbox (by the Message-ID the BFF made), for when the request that created
   * them failed without saying what it made: the latest messages of its Drafts and Sent, matched by Message-ID. Not an
   * `Email/query` `header: ["Message-ID", id]` filter: on the pinned v0.16.27 it never matched a just-created message
   * (bare or bracketed id, still nothing after 2 s; probed 2026-10-30), while the folder listing is immediate. The
   * copies were created moments before, so they are among the newest 50 of their folder.
   */
  async #findCopies(sessionId: string, entry: MailboxTokens, folders: string[], messageId: string): Promise<string[]> {
    const r = await this.#callDelegated(
      sessionId,
      entry,
      (t) => [
        ...folders.map((f, i): [string, Record<string, unknown>, string] => [
          "Email/query",
          {
            accountId: t.accountId,
            filter: { inMailbox: f },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: 50,
          },
          `q${String(i)}`,
        ]),
      ],
      USING,
    );
    const ids = folders.flatMap((_, i) => (r.get(`q${String(i)}`)?.ids as string[] | undefined) ?? []);
    if (ids.length === 0) return [];
    const g = await this.#callDelegated(
      sessionId,
      entry,
      (t) => [["Email/get", { accountId: t.accountId, ids, properties: ["messageId"] }, "g"]],
      USING,
    );
    return ((g.get("g")?.list ?? []) as { id: string; messageId: string[] | null }[])
      .filter((e) => (e.messageId ?? []).includes(messageId))
      .map((e) => e.id);
  }

  /** Whether a submission of `emailId` exists in a delegated entry's account (after an answer was lost); its id. */
  async #submissionOf(sessionId: string, entry: MailboxTokens, emailId: string): Promise<string | null> {
    const r = await this.#callDelegated(
      sessionId,
      entry,
      (t) => [["EmailSubmission/query", { accountId: t.accountId, filter: { emailIds: [emailId] } }, "q"]],
      USING_SUBMISSION,
    );
    return ((r.get("q")?.ids as string[] | undefined) ?? [])[0] ?? null;
  }

  /**
   * Sends a saved draft of the person's own mailbox **from a mailbox shared with them** (`from`), as that mailbox (send
   * as) or on its behalf (`Sender:` the person), ADR-0026 §6 and §8:
   *
   * 1. the draft (in the active own mailbox, from identity `identityId`) passes the usual checks against the stricter
   *    of the shared mailbox's and the sender's own sending tier; the shared mailbox's entry is opened for sending (or
   *    reused) and passes the gate;
   * 2. the right is checked **now** (uncached) and the send audited (`authorizeSend`) before any work is done in that
   *    mailbox — no blob copied, no quota charged without it (review L4);
   * 3. its attachments are copied into the shared mailbox; its quota windows (the mailbox's and this session's) are
   *    charged, failing closed; the right is checked once more, uncached, and `Sender:` and the tag are built right
   *    after (requirement 2);
   * 4. the copies are created, then submitted in a second request (so their ids are known whatever happens next).
   *    Send as: created in that mailbox's Drafts, submitted from its own identity, moved to its Sent by
   *    `onSuccessUpdateEmail`. Send on behalf: a kept copy in its Sent **without** a tag, and a temporary copy carrying
   *    `Sender:`, the tag and its expiry, submitted with `onSuccessDestroyEmail` — so no stored message ever holds a
   *    tag (requirement 1). Both copies share the Message-ID made here;
   * 5. anything that stops it after the audit entry — a refusal, a method error, a lost answer (then the mail server is
   *    asked what was made or submitted) — destroys every copy that wasn't sent and records `delegation.send_failed`;
   *    a tagged copy that outlives a sent message is destroyed (retried once) or recorded `delegation.tagged_copy_left`;
   * 6. the own draft stays until the undo hold is over, then is removed; undo (`undoSend` with `mailbox`) cancels the
   *    submission, removes the stored copy and hands the own draft back.
   */
  async #sendDelegated(
    sessionId: string,
    draftId: string,
    identityId: string,
    from: string,
    shown: string | undefined,
    req: RequestMeta,
    beforeOpen?: () => Promise<void>,
  ): Promise<SendResult> {
    const delegation = this.#d.delegation;
    if (!delegation) throw new WebmailDelegationRefusedError("delegation not configured");
    const s = await this.#pin(sessionId, shown);
    const ownAccount = s.accountId;
    const via = s.username.toLowerCase();
    const want = from.trim().toLowerCase();
    // The stricter of the shared mailbox's tier and the sender's own (ADR-0026 §6): neither loosens the other.
    const limits = delegatedSendingLimits(want, s.username);
    const chosen = await this.#d.holdSeconds(s.username).catch(() => UNDO_SECONDS);
    const hold = Number.isInteger(chosen) && chosen >= 1 && chosen <= 60 ? chosen : UNDO_SECONDS;
    const [identity, roles, ownIdentities] = await Promise.all([
      this.#identity(sessionId, identityId),
      this.roles(sessionId),
      this.identities(sessionId),
    ]);
    if (!roles.drafts) throw new WebmailUnavailableError("no Drafts folder");
    const draft = await this.#fullDraft(sessionId, draftId, ownAccount);
    if (!draft) throw new WebmailRefusedError("Only a saved draft can be sent.");
    const check = sendCheck(draft, identity, roles.drafts, limits);
    if (!check.ok) throw new WebmailRefusedError(check.message);
    const input = this.#rebuild(draft, identityId);
    // The Sender is the active mailbox's own address, named as the From picker names it (its own identity's name).
    const viaIdentity = ownIdentities.find((i) => i.email.toLowerCase() === via) ?? identity;

    const entry = await this.#delegatedFor(sessionId, via, want, "send", req, beforeOpen);
    const d = entry.delegated;
    if (!d) throw new WebmailDelegationRefusedError("not granted");
    const who = { mailboxId: d.mailboxId, granteeUserId: d.granteeUserId, via: d.via };
    const refused = async (): Promise<never> => {
      await this.#dropDelegated(sessionId, new Set([entry.username]));
      throw new WebmailDelegationRefusedError("not granted");
    };

    // The right now, uncached, and the audit entry — before any work in that mailbox (requirement 2, review L4).
    let auth: DelegatedSendAuthorization;
    try {
      auth = await delegation.authorizeSend(
        { ...who, console: s.console ?? null, recipientCount: check.rcptTo.length },
        req,
      );
    } catch (err) {
      if (err instanceof DelegatedMailboxRefusedError) return refused();
      throw err;
    }
    if (auth.address !== want || auth.via !== via) return refused();

    /** Audited as sent but stopped before a submission: what was made goes, and the stop is recorded. */
    const made: string[] = [];
    let submittedAt: { id: string; sendAt?: string } | null = null;
    /** Settled otherwise (sent, or unknown whether it was): nothing more to clean up or record on the way out. */
    let settled = false;
    const failed = async (reason: string) => {
      if (submittedAt || settled) return;
      if (made.length > 0 && !(await this.#destroyDelegated(sessionId, entry, made))) {
        log.error("webmail: unsent delegated copies left", { component: "webmail", count: made.length });
      }
      await this.#recordOutcome(who, { kind: "failed", reason }, req);
    };
    try {
      const meta = await this.#callDelegated(
        sessionId,
        entry,
        (t) => [
          ["Mailbox/get", { accountId: t.accountId, ids: null, properties: ["role"] }, "m"],
          ["Identity/get", { accountId: t.accountId, ids: null, properties: ["name", "email"] }, "i"],
        ],
        USING_SUBMISSION,
      );
      const boxes = (meta.get("m")?.list ?? []) as { id: string; role: string | null }[];
      const theirDrafts = boxes.find((b) => b.role === "drafts")?.id;
      const theirSent = boxes.find((b) => b.role === "sent")?.id;
      if (!theirDrafts || !theirSent) throw new WebmailUnavailableError("no Drafts or Sent folder");
      // Its own address, never one of its aliases: the From is the mailbox itself.
      const theirs = ((meta.get("i")?.list ?? []) as Identity[]).find((i) => i.email.toLowerCase() === want);
      if (!theirs) throw new WebmailUnavailableError("the mailbox has no sending identity");
      const attachments = await this.#copyAttachments(sessionId, ownAccount, entry, input.attachments);

      // Charged to the stricter limits, per mailbox sent from and per session, failing closed (rule 27).
      const sessionKey = createHash("sha256").update(sessionId).digest("base64url").slice(0, 22);
      let allowed: boolean;
      try {
        allowed = await this.#d.quota.take(
          sendWindows(want, sessionKey, limits),
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
          `This mailbox has reached its sending limit for now (${String(limits.messagesPerHour)} recipients an hour, ${String(limits.messagesPerDay)} a day). Try again later.`,
        );
      }

      // Once more, uncached, right before Sender and the tag are built: a revoke since the audit stops it here.
      const mode = await delegation.checkSend({ ...who, console: s.console ?? null });
      if (mode !== auth.mode) throw new WebmailDelegationRefusedError("not granted");

      const domain = want.split("@")[1] ?? "";
      const messageId = `${randomUUID()}@${domain}`;
      const base = draftEmail({ ...input, attachments }, theirs, theirDrafts);
      let creates: Record<string, Record<string, unknown>>;
      if (mode === "send_as") {
        creates = { e: { ...base, keywords: { $draft: true, $seen: true }, messageId: [messageId] } };
      } else {
        // Sender and the tag are built here only, right after the check (requirement 2); never from the client.
        let tag: string;
        const expires = onBehalfExpires(this.#d.now());
        try {
          if (!this.#d.onBehalfKey) throw new Error("no key");
          tag = onBehalfTag(this.#d.onBehalfKey(), want, via, messageId, expires);
        } catch (err) {
          log.warn("webmail send on behalf unavailable", {
            component: "webmail",
            error: err instanceof OnBehalfTagError ? "address" : "key",
          });
          throw err instanceof OnBehalfTagError
            ? new WebmailRefusedError("This message can't be sent on behalf of that mailbox.")
            : new WebmailUnavailableError("sending on behalf is unavailable right now");
        }
        const sender = [{ name: senderName(viaIdentity), email: via }];
        creates = {
          // The copy kept in the mailbox's Sent: no tag, no expiry, the same Message-ID (threads hold).
          kept: {
            ...base,
            mailboxIds: { [theirSent]: true },
            keywords: { $seen: true },
            messageId: [messageId],
            sender,
          },
          // The copy submitted and destroyed by the submission itself; not a draft, so nothing else sends it.
          temp: {
            ...base,
            keywords: { $seen: true },
            messageId: [messageId],
            sender,
            [`header:${ON_BEHALF_EXPIRES_HEADER}:asText`]: expires,
            [`header:${ON_BEHALF_HEADER}:asText`]: tag,
          },
        };
      }

      // 1. The copies. A lost answer: ask the mail server what it made (by our Message-ID) so it goes too.
      let createdIds: Record<string, { id: string }>;
      try {
        const r = await this.#callDelegated(
          sessionId,
          entry,
          (t) => [["Email/set", { accountId: t.accountId, create: creates }, "e"]],
          USING,
        );
        createdIds = (r.get("e")?.created as Record<string, { id: string }> | undefined) ?? {};
      } catch (err) {
        try {
          made.push(...(await this.#findCopies(sessionId, entry, [theirDrafts, theirSent], messageId)));
        } catch (lookup) {
          log.error("webmail: delegated copies not looked up after a failed send", { component: "webmail", lookup });
        }
        throw err;
      }
      made.push(...Object.values(createdIds).map((m) => m.id));
      const submitted = (mode === "send_as" ? createdIds.e : createdIds.temp)?.id;
      const stored = (mode === "send_as" ? createdIds.e : createdIds.kept)?.id;
      if (!submitted || !stored || made.length !== Object.keys(creates).length) {
        log.warn("webmail delegated copies not created", { component: "webmail" });
        throw new WebmailRefusedError("The mail server didn't accept this message.");
      }

      // 2. The submission of exactly that copy. A lost answer: ask whether it was submitted.
      const envelope = {
        mailFrom: { email: theirs.email, parameters: { HOLDFOR: String(hold) } },
        rcptTo: check.rcptTo.map((email) => ({ email })),
      };
      const after =
        mode === "send_as"
          ? {
              onSuccessUpdateEmail: {
                "#send": {
                  [`mailboxIds/${theirDrafts}`]: null,
                  [`mailboxIds/${theirSent}`]: true,
                  "keywords/$draft": null,
                },
              },
            }
          : { onSuccessDestroyEmail: ["#send"] };
      let destroyedBySubmission: string[] = [];
      try {
        const r = await this.#callDelegated(
          sessionId,
          entry,
          (t) => [
            [
              "EmailSubmission/set",
              {
                accountId: t.accountId,
                create: { send: { identityId: theirs.id, emailId: submitted, envelope } },
                ...after,
              },
              "s",
            ],
          ],
          USING_SUBMISSION,
        );
        const created = (r.get("s")?.created as Record<string, { id: string; sendAt?: string }> | undefined)?.send;
        if (!created) {
          const why = (r.get("s")?.notCreated as Record<string, { type?: string }> | undefined)?.send?.type;
          log.warn("webmail delegated submission refused", { component: "webmail", type: why ?? "unknown" });
          throw new WebmailRefusedError("The mail server didn't accept this message.");
        }
        submittedAt = created;
        destroyedBySubmission = (r.get("s#Email/set")?.destroyed as string[] | undefined) ?? [];
      } catch (err) {
        if (err instanceof WebmailRefusedError) throw err;
        let found: string | null;
        try {
          found = await this.#submissionOf(sessionId, entry, submitted);
        } catch (lookup) {
          // Unknown is not "not submitted": it may still be delivered. Keep the stored copy (it is the record of a
          // message that may have gone), remove only the tagged one, and tell the person to check before resending.
          log.error("webmail: delegated submission not looked up after a lost answer", {
            component: "webmail",
            lookup,
          });
          settled = true;
          if (mode === "send_on_behalf" && !(await this.#destroyDelegated(sessionId, entry, [submitted]))) {
            log.error("webmail: tagged copy left after an unconfirmed delegated send", { component: "webmail" });
          }
          await this.#recordOutcome(who, { kind: "failed", reason: "unknown" }, req).catch(() => undefined);
          throw new WebmailSendUnconfirmedError("unconfirmed");
        }
        if (!found) throw err;
        submittedAt = { id: found };
      }

      // Sent: undo and the end of the hold come first, whatever happens to the cleanup and its record below.
      this.#holdDelegated(sessionId, {
        key: this.#heldKey(sessionId, want, submittedAt.id),
        mailbox: want,
        ...who,
        storedId: stored,
        ownDraftId: draftId,
        ownAccount,
        hold,
      });
      // The tagged copy must not outlive it (requirement 1). A record that can't be written is logged (by
      // `#recordOutcome`), never turned into a failure of a message that was sent.
      if (mode === "send_on_behalf" && !destroyedBySubmission.includes(submitted)) {
        if (!(await this.#destroyDelegated(sessionId, entry, [submitted]))) {
          log.error("webmail: tagged copy left after a delegated send", { component: "webmail" });
          await this.#recordOutcome(who, { kind: "tagged_copy_left" }, req).catch(() => undefined);
        }
      }
      return {
        submissionId: submittedAt.id,
        sendAt: submittedAt.sendAt ?? new Date(this.#d.now() + hold * 1000).toISOString(),
        holdSeconds: hold,
        from: want,
      };
    } catch (err) {
      await failed(
        err instanceof Error
          ? err.name
              .replace(/^Webmail/, "")
              .replace(/Error$/, "")
              .toLowerCase()
          : "unknown",
      );
      if (err instanceof WebmailDelegationRefusedError) await this.#dropDelegated(sessionId, new Set([entry.username]));
      throw err;
    }
  }

  /**
   * Records a delegated send's outcome, retried once; a record that can't be written is an error (logged), never
   * silent. Throws when both attempts fail, so the caller can say so.
   */
  async #recordOutcome(
    who: { mailboxId: string; granteeUserId: string; via: string },
    outcome: DelegatedSendOutcome,
    req: RequestMeta,
  ): Promise<void> {
    const delegation = this.#d.delegation;
    if (!delegation) return;
    try {
      await delegation.sendOutcome(who, outcome, req);
    } catch {
      try {
        await delegation.sendOutcome(who, outcome, req);
      } catch (err) {
        log.error("webmail: delegated send outcome not audited", { component: "webmail", outcome: outcome.kind, err });
        throw new WebmailUnavailableError("delegated send outcome not recorded");
      }
    }
  }

  /** Keeps what undo and the end of the hold need for a delegated send (`#heldSends`) and schedules the end. */
  #holdDelegated(sessionId: string, h: Omit<HeldSend, "until"> & { key: string; hold: number }): void {
    const { key, hold, ...rest } = h;
    if (this.#heldSends.size > 1_000) {
      const now = this.#d.now();
      for (const [k, v] of this.#heldSends) if (v.until < now) this.#heldSends.delete(k);
    }
    this.#heldSends.set(key, { ...rest, until: this.#d.now() + (hold + 60) * 1000 });
    this.#d.defer(
      () => {
        this.#afterDelegatedHold(sessionId, key).catch((err: unknown) => {
          log.warn("webmail: own draft not removed after a delegated send", {
            component: "webmail",
            error: err instanceof Error ? err.name : "unknown",
          });
        });
      },
      (hold + 2) * 1000,
    );
  }

  /** The undo hold of a delegated send is over (not undone): the person's own draft it came from goes. */
  async #afterDelegatedHold(sessionId: string, key: string): Promise<void> {
    const held = this.#heldSends.get(key);
    if (!held) return; // Undone: the draft is the person's again.
    this.#heldSends.delete(key);
    const r = await this.#call(
      sessionId,
      (x) => [["Email/get", { accountId: x.accountId, ids: [held.ownDraftId], properties: ["keywords"] }, "g"]],
      USING,
      held.ownAccount,
      { inactive: true },
    );
    const found = ((r.get("g")?.list ?? []) as { keywords: Record<string, boolean> }[])[0];
    // Only the draft the BFF built, still a draft: never a message the person moved or changed since.
    if (found?.keywords.$draft !== true || found.keywords[COMPOSED_KEYWORD] !== true) return;
    await this.#call(
      sessionId,
      (x) => [["Email/set", { accountId: x.accountId, destroy: [held.ownDraftId] }, "d"]],
      USING,
      held.ownAccount,
      { inactive: true },
    );
  }

  /**
   * Undo of a delegated send (`undoSend` with `mailbox`): see `#sendDelegated`. Only with the entry the send used,
   * still in this session — undo never opens a mailbox (no credential is minted for it, review L3). It does **not**
   * re-check the send right: cancelling the BFF's own held submission only reduces what is sent, so a revoke during the
   * hold doesn't stop it (decision recorded in ADR-0026 slice 13). The person's own sign-in is still proven first, and
   * an entry the gate or the mail server dropped meanwhile is gone (then "It has already been sent.": the message goes).
   * The cancel is recorded (`delegation.send_cancelled`, retried once); a record that can't be written answers an error
   * after the cancel, so a missing audit row is never silent.
   */
  async #undoDelegated(
    sessionId: string,
    submissionId: string,
    account: string | undefined,
    mailbox: string,
    req: RequestMeta,
  ): Promise<{ draftId: string }> {
    const s = await this.#pin(sessionId, account);
    const want = mailbox.trim().toLowerCase();
    const key = this.#heldKey(sessionId, want, submissionId);
    const held = this.#heldSends.get(key);
    const already = () => new WebmailRefusedError("It has already been sent.");
    if (held?.ownAccount !== s.accountId || held.until < this.#d.now()) throw already();
    const cur = await this.#d.store.read(sessionId);
    const entry = cur
      ? [cur, ...(cur.others ?? [])].find(
          (m) => m.delegated?.mailboxId === held.mailboxId && m.username.toLowerCase() === want,
        )
      : undefined;
    if (!cur || entry?.delegated?.via !== held.via) throw already();
    await this.#proveOwn(sessionId, cur, held.via);
    const r = await this.#callDelegated(
      sessionId,
      entry,
      (t) => [
        [
          "EmailSubmission/set",
          { accountId: t.accountId, update: { [submissionId]: { undoStatus: "canceled" } } },
          "u",
        ],
      ],
      USING_SUBMISSION,
    );
    const updated = r.get("u")?.updated as Record<string, unknown> | undefined;
    if (!updated || !(submissionId in updated)) throw already();
    this.#heldSends.delete(key);
    if (!(await this.#destroyDelegated(sessionId, entry, [held.storedId]))) {
      log.warn("webmail: undone delegated copy not removed", { component: "webmail" });
    }
    await this.#recordOutcome(held, { kind: "cancelled" }, req);
    return { draftId: held.ownDraftId };
  }

  /**
   * Refuses when the browser tab shows another mailbox than the session's active one (switched in another tab):
   * drafts, sending, undo and uploads must never act on a mailbox the person isn't looking at. `account` undefined =
   * a server-internal caller (tests, the BFF itself).
   */
  async #pin(sessionId: string, account: string | undefined): Promise<WebmailSession> {
    // Drafts, sending, undo and uploads: the person's own mailbox only until send rights are used (ADR-0026 slice 13).
    const s = await this.#ownActive(sessionId);
    if (account !== undefined && s.accountId !== account) {
      throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    }
    return s;
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
    const r = await this.#call(
      sessionId,
      (s) => [["Mailbox/get", { accountId: s.accountId, ids: null, properties: ["role"] }, "m"]],
      USING,
      undefined,
      { access: READ },
    );
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
    // A delegated mailbox's identities need a send right (ADR-0026 §6); none is used yet.
    const accountId = (await this.#ownActive(sessionId)).accountId;
    const hit = this.#identities.get(accountId);
    if (hit && this.#d.now() - hit.at < META_TTL_MS) return hit.list;
    const r = await this.#call(
      sessionId,
      (s) => [
        ["Identity/get", { accountId: s.accountId, ids: null, properties: ["name", "email", "textSignature"] }, "i"],
      ],
      USING_SUBMISSION,
      // Cached under this account: the answer must be this account's, whatever became active meanwhile.
      accountId,
    );
    const list = ((r.get("i")?.list ?? []) as (Identity & { textSignature?: string | null })[]).map((i) => ({
      id: i.id,
      name: i.name,
      email: i.email,
      signature: i.textSignature ?? "",
    }));
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
    const r = await this.#call(
      sessionId,
      (s) => [["Email/get", { accountId: s.accountId, ids, properties: ["mailboxIds"] }, "g"]],
      USING,
      undefined,
      { access: READ },
    );
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
  async saveDraft(sessionId: string, input: DraftInput, account?: string): Promise<{ id: string }> {
    const problem = draftProblem(input);
    if (problem) throw new WebmailRefusedError(problem.message);
    const pinned = (await this.#pin(sessionId, account)).accountId;
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
    const r = await this.#call(
      sessionId,
      (s) => [
        [
          "Email/set",
          {
            accountId: s.accountId,
            create: { draft: draftEmail(input, identity, drafts) },
            ...(input.replaces ? { destroy: [input.replaces] } : {}),
          },
          "d",
        ],
      ],
      USING,
      pinned,
    );
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
    shown?: string,
    /**
     * Send from a mailbox shared with the person (`from`, its address) instead of the draft's own identity: see
     * `#sendDelegated`. `req` is for the audit; `beforeOpen` runs before a delegated entry is minted for it.
     */
    delegated?: { from: string; req: RequestMeta; beforeOpen?: () => Promise<void> },
  ): Promise<SendResult> {
    if (delegated) {
      return this.#sendDelegated(
        sessionId,
        draftId,
        identityId,
        delegated.from,
        shown,
        delegated.req,
        delegated.beforeOpen,
      );
    }
    // Everything below runs against this mailbox — the one the tab shows: the quota is charged to it, and every call
    // refuses if the active mailbox changes meanwhile.
    const s = await this.#pin(sessionId, shown);
    const account = s.accountId;
    const limits = sendingLimits(s.username);
    const chosen = await this.#d.holdSeconds(s.username).catch(() => UNDO_SECONDS);
    // Within what the server's hold supports and the app offers; anything else falls back to the default.
    const hold = Number.isInteger(chosen) && chosen >= 1 && chosen <= 60 ? chosen : UNDO_SECONDS;
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
                  mailFrom: { email: identity.email, parameters: { HOLDFOR: String(hold) } },
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
    // Save new recipients to Other contacts once the message is really sent (after the undo hold), never while
    // the person can still undo it, and never delaying this response.
    this.#afterHold(sessionId, account, draft, created.id, 0, hold);
    return {
      submissionId: created.id,
      sendAt: created.sendAt ?? new Date(this.#d.now() + hold * 1000).toISOString(),
      holdSeconds: hold,
    };
  }

  /** Cancels a held submission and puts its message back in Drafts. "Already sent" when it is too late. */
  async undoSend(
    sessionId: string,
    submissionId: string,
    account?: string,
    /** A send from a mailbox shared with the person: its address, and the request for the audit. */
    delegated?: { mailbox: string; req: RequestMeta },
  ): Promise<{ draftId: string }> {
    if (delegated) return this.#undoDelegated(sessionId, submissionId, account, delegated.mailbox, delegated.req);
    const pinned = (await this.#pin(sessionId, account)).accountId;
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
      pinned,
    );
    const sub = ((r.get("g")?.list ?? []) as { emailId: string; undoStatus: string }[])[0];
    const updated = r.get("u")?.updated as Record<string, unknown> | undefined;
    if (!sub || !updated || !(submissionId in updated)) throw new WebmailRefusedError("It has already been sent.");
    await this.#call(
      sessionId,
      (s) => [
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
      ],
      USING,
      pinned,
    );
    return { draftId: sub.emailId };
  }

  /** Uploads one attachment (already size-capped by the caller) to the active mailbox. */
  async upload(
    sessionId: string,
    bytes: Uint8Array<ArrayBuffer>,
    type: string,
    account?: string,
  ): Promise<{ blobId: string; type: string; size: number }> {
    const pinned = (await this.#pin(sessionId, account)).accountId;
    const { value } = await this.#withSession(sessionId, async (s) => {
      // Switched between the pin and now: refuse rather than upload into another mailbox.
      if (s.accountId !== pinned) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
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

  // ---- contacts (JMAP Contacts, RFC 9610) ---------------------------------------------------------------------
  //
  // Every contacts call takes the account the app is showing (`account`) and refuses if the session's active
  // mailbox is another one (it was switched in another tab), like send.

  async #books(
    sessionId: string,
    account: string,
    inactive = false,
  ): Promise<(BookView & { description: string | null })[]> {
    const r = await this.#call(
      sessionId,
      (x) => [["AddressBook/get", { accountId: x.accountId, ids: null }, "b"]],
      USING_CONTACTS,
      account,
      { inactive },
    );
    return (
      (r.get("b")?.list ?? []) as { id: string; name: string; isDefault?: boolean; description?: string | null }[]
    ).map((b) => ({
      id: b.id,
      name: b.name === OTHER_BOOK_NAME ? OTHER_BOOK_NAME : b.isDefault ? "My contacts" : b.name,
      isDefault: b.isDefault === true,
      isOther: b.name === OTHER_BOOK_NAME,
      description: b.description ?? null,
    }));
  }

  /** The address book for contacts you add yourself ("My contacts"): the default one, else the first non-Other. */
  async #mineBook(sessionId: string, account: string): Promise<string> {
    const books = await this.#books(sessionId, account);
    const mine = books.find((b) => b.isDefault && !b.isOther) ?? books.find((b) => !b.isOther);
    if (mine) return mine.id;
    const r = await this.#call(
      sessionId,
      (x) => [["AddressBook/set", { accountId: x.accountId, create: { b: { name: "My contacts" } } }, "s"]],
      USING_CONTACTS,
      account,
    );
    const id = (r.get("s")?.created as Record<string, { id: string }> | undefined)?.b?.id;
    if (!id) throw new WebmailUnavailableError("address book not created");
    return id;
  }

  /** The "Other contacts" book (created when first needed, with automatic saving on). */
  async #otherBook(sessionId: string, account: string, inactive = false): Promise<string> {
    const existing = (await this.#books(sessionId, account, inactive)).find((b) => b.isOther);
    if (existing) return existing.id;
    const r = await this.#call(
      sessionId,
      (x) => [
        [
          "AddressBook/set",
          { accountId: x.accountId, create: { o: { name: OTHER_BOOK_NAME, description: AUTO_SAVE_ON } } },
          "s",
        ],
      ],
      USING_CONTACTS,
      account,
      { inactive },
    );
    const id = (r.get("s")?.created as Record<string, { id: string }> | undefined)?.o?.id;
    if (!id) throw new WebmailUnavailableError("address book not created");
    return id;
  }

  /** How many cards the mailbox holds (any book, including ones added over CardDAV). */
  async #cardCount(sessionId: string, account: string): Promise<number> {
    const r = await this.#call(
      sessionId,
      (x) => [["ContactCard/query", { accountId: x.accountId, limit: 1, calculateTotal: true }, "q"]],
      USING_CONTACTS,
      account,
    );
    return Number(r.get("q")?.total ?? 0);
  }

  /**
   * The first `MAX_CONTACTS` cards with these properties, and how many there are in all: the ids first, then the
   * cards in batches the server accepts (`getMaxResults` is 500 per `ContactCard/get`).
   */
  async #allCards(
    sessionId: string,
    properties: readonly string[],
    account?: string,
    inactive = false,
  ): Promise<{ cards: Record<string, unknown>[]; total: number; accountId: string }> {
    let accountId = "";
    const q = await this.#call(
      sessionId,
      (x) => {
        accountId = x.accountId;
        return [["ContactCard/query", { accountId: x.accountId, limit: MAX_CONTACTS, calculateTotal: true }, "q"]];
      },
      USING_CONTACTS,
      account,
      { inactive },
    );
    const ids = ((q.get("q")?.ids ?? []) as string[]).slice(0, MAX_CONTACTS);
    const total = Math.max(Number(q.get("q")?.total ?? 0), ids.length);
    if (ids.length === 0) return { cards: [], total, accountId };
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += CARD_BATCH) batches.push(ids.slice(i, i + CARD_BATCH));
    const r = await this.#call(
      sessionId,
      (x) =>
        batches.map((b, i) => ["ContactCard/get", { accountId: x.accountId, ids: b, properties }, `g${String(i)}`]),
      USING_CONTACTS,
      accountId,
      { inactive },
    );
    return {
      cards: batches.flatMap((_, i) => (r.get(`g${String(i)}`)?.list ?? []) as Record<string, unknown>[]),
      total,
      accountId,
    };
  }

  /**
   * The contacts (the first `MAX_CONTACTS`; `truncated` says there are more), the address books, whether people
   * you email are saved, and the account they belong to (the app sends it back with every change).
   */
  async contacts(sessionId: string): Promise<{
    accountId: string;
    books: BookView[];
    contacts: ContactView[];
    autoSave: boolean;
    truncated: boolean;
  }> {
    const { cards, total, accountId } = await this.#allCards(sessionId, CARD_PROPERTIES);
    const books = await this.#books(sessionId, accountId);
    const contacts = (cards as Parameters<typeof contactView>[0][])
      .filter((c) => c.kind === undefined || c.kind === "individual")
      .map(contactView)
      .sort((a, b) => a.name.localeCompare(b.name, "en-CA", { sensitivity: "base" }));
    const other = books.find((b) => b.isOther);
    return {
      accountId,
      books: books.map(({ description: _d, ...b }) => b),
      contacts,
      autoSave: other ? other.description !== AUTO_SAVE_OFF : true,
      truncated: total > MAX_CONTACTS,
    };
  }

  async createContact(
    sessionId: string,
    account: string,
    input: ContactInput,
    book: "mine" | "other" = "mine",
  ): Promise<{ id: string }> {
    if ((await this.#cardCount(sessionId, account)) >= MAX_CONTACTS) throw new WebmailRefusedError(CONTACTS_FULL);
    const bookId =
      book === "other" ? await this.#otherBook(sessionId, account) : await this.#mineBook(sessionId, account);
    const r = await this.#call(
      sessionId,
      (x) => [["ContactCard/set", { accountId: x.accountId, create: { c: newCard(input, bookId) } }, "s"]],
      USING_CONTACTS,
      account,
    );
    const id = (r.get("s")?.created as Record<string, { id: string }> | undefined)?.c?.id;
    if (!id) throw new WebmailRefusedError("The contact couldn't be saved.");
    this.#afterContactsChange(sessionId, account);
    return { id };
  }

  /** Replaces the fields we manage (name, emails, phones, organisation, notes, birthday, labels) on a contact. */
  async updateContact(sessionId: string, account: string, id: string, input: ContactInput): Promise<void> {
    const r = await this.#call(
      sessionId,
      (x) => [["ContactCard/set", { accountId: x.accountId, update: { [id]: cardFields(input) } }, "s"]],
      USING_CONTACTS,
      account,
    );
    const updated = r.get("s")?.updated as Record<string, unknown> | undefined;
    if (!updated || !(id in updated)) throw new WebmailRefusedError("That contact couldn't be changed.");
    this.#afterContactsChange(sessionId, account);
  }

  async deleteContacts(sessionId: string, account: string, ids: string[]): Promise<number> {
    const r = await this.#call(
      sessionId,
      (x) => [["ContactCard/set", { accountId: x.accountId, destroy: ids }, "s"]],
      USING_CONTACTS,
      account,
    );
    this.#afterContactsChange(sessionId, account);
    return ((r.get("s")?.destroyed ?? []) as string[]).length;
  }

  /** Moves contacts to My contacts or Other contacts; returns how many the server actually moved. */
  async moveContacts(sessionId: string, account: string, ids: string[], to: "mine" | "other"): Promise<number> {
    const bookId =
      to === "other" ? await this.#otherBook(sessionId, account) : await this.#mineBook(sessionId, account);
    const r = await this.#call(
      sessionId,
      (x) => [
        [
          "ContactCard/set",
          {
            accountId: x.accountId,
            update: Object.fromEntries(ids.map((id) => [id, { addressBookIds: { [bookId]: true } }])),
          },
          "s",
        ],
      ],
      USING_CONTACTS,
      account,
    );
    return Object.keys((r.get("s")?.updated as Record<string, unknown> | undefined) ?? {}).length;
  }

  /** Turns saving people you email on or off (stored on the Other contacts book in Stalwart). */
  async setAutoSave(sessionId: string, account: string, on: boolean): Promise<void> {
    const id = await this.#otherBook(sessionId, account);
    await this.#call(
      sessionId,
      (x) => [
        [
          "AddressBook/set",
          { accountId: x.accountId, update: { [id]: { description: on ? AUTO_SAVE_ON : AUTO_SAVE_OFF } } },
          "s",
        ],
      ],
      USING_CONTACTS,
      account,
    );
  }

  /**
   * Imports a .vcf file into My contacts (parsed and capped here). Cards beyond the mailbox's room (`MAX_CONTACTS`
   * in all) are skipped, and `full` says so.
   */
  async importContacts(
    sessionId: string,
    account: string,
    vcf: string,
  ): Promise<{ imported: number; skipped: number; full: boolean }> {
    const { contacts: parsed, skipped } = parseVcards(vcf);
    if (parsed.length === 0) return { imported: 0, skipped, full: false };
    const room = Math.max(0, MAX_CONTACTS - (await this.#cardCount(sessionId, account)));
    const contacts = parsed.slice(0, room);
    const full = contacts.length < parsed.length;
    if (contacts.length === 0) return { imported: 0, skipped: skipped + parsed.length, full };
    const bookId = await this.#mineBook(sessionId, account);
    let imported = 0;
    for (let i = 0; i < contacts.length; i += 200) {
      const chunk = contacts.slice(i, i + 200);
      const r = await this.#call(
        sessionId,
        (x) => [
          [
            "ContactCard/set",
            {
              accountId: x.accountId,
              create: Object.fromEntries(chunk.map((c, j) => [`c${String(j)}`, newCard(c, bookId)])),
            },
            "s",
          ],
        ],
        USING_CONTACTS,
        account,
      );
      imported += Object.keys((r.get("s")?.created as Record<string, unknown> | undefined) ?? {}).length;
    }
    this.#afterContactsChange(sessionId, account);
    return { imported, skipped: skipped + parsed.length - imported, full };
  }

  /** Contacts (all, or these ids) as a vCard file. */
  async exportContacts(sessionId: string, ids?: string[]): Promise<string> {
    const { contacts } = await this.contacts(sessionId);
    const wanted = ids ? new Set(ids) : null;
    return toVcards(wanted ? contacts.filter((c) => wanted.has(c.id)) : contacts);
  }

  /**
   * Schedules auto-save for a send: after the undo hold, check the submission and save only if it wasn't undone.
   * Best effort and in this process (a restart in those few seconds skips it); errors are logged by kind only.
   */
  #afterHold(
    sessionId: string,
    account: string,
    draft: StoredDraft,
    submissionId: string,
    attempt: number,
    hold = UNDO_SECONDS,
  ): void {
    const run = () => {
      this.#autoSaveIfSent(sessionId, account, draft, submissionId, attempt).catch((err: unknown) => {
        // The error's kind only: nothing about recipients reaches the logs (rule 24).
        log.warn("webmail contact auto-save failed", {
          component: "webmail",
          error: err instanceof Error ? err.name : "unknown",
        });
      });
    };
    this.#d.defer(run, attempt === 0 ? (hold + 2) * 1000 : 5000);
  }

  async #autoSaveIfSent(
    sessionId: string,
    account: string,
    draft: StoredDraft,
    submissionId: string,
    attempt: number,
  ): Promise<void> {
    const r = await this.#call(
      sessionId,
      (x) => [
        ["EmailSubmission/get", { accountId: x.accountId, ids: [submissionId], properties: ["undoStatus"] }, "g"],
      ],
      USING_SUBMISSION,
      account,
      // The person may have switched mailbox during the hold: still the account that sent.
      { inactive: true },
    );
    const status = ((r.get("g")?.list ?? []) as { undoStatus?: string }[])[0]?.undoStatus;
    if (status === "canceled") return; // Undone: nobody was emailed.
    if (status === "pending") {
      if (attempt < 3) this.#afterHold(sessionId, account, draft, submissionId, attempt + 1);
      return;
    }
    await this.#autoSave(sessionId, account, draft);
  }

  /**
   * Every recipient not on any card (matched case-insensitively by address) is added to Other contacts with the
   * name the message used. Existing contacts are never changed; at most `MAX_AUTO_SAVE` per send, and never past
   * the mailbox's `MAX_CONTACTS`.
   */
  async #autoSave(sessionId: string, account: string, draft: StoredDraft): Promise<void> {
    const people = new Map<string, string | null>();
    for (const a of [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])]) {
      const key = a.email.toLowerCase();
      if (!people.has(key) || (!people.get(key) && a.name)) people.set(key, a.name ?? null);
    }
    if (people.size === 0) return;
    const books = await this.#books(sessionId, account, true);
    const other = books.find((b) => b.isOther);
    if (other?.description === AUTO_SAVE_OFF) return;
    const addresses = [...people.keys()].slice(0, MAX_AUTO_SAVE);
    // Addresses already saved, read from the cards themselves: the `email` query filter goes through the search
    // index, which lags fresh writes (a contact saved a moment ago would be missed and duplicated).
    const { cards, total } = await this.#allCards(sessionId, ["emails"], account, true);
    if (total >= MAX_CONTACTS) return;
    const known = new Set(
      (cards as { emails?: Record<string, { address?: string }> }[]).flatMap((c) =>
        Object.values(c.emails ?? {}).map((e) => (e.address ?? "").toLowerCase()),
      ),
    );
    // Below the cap every card was read, so this check is complete; at the cap nothing more is saved.
    const fresh = addresses.filter((a) => !known.has(a)).slice(0, Math.max(0, MAX_CONTACTS - total));
    if (fresh.length === 0) return;
    const bookId = other?.id ?? (await this.#otherBook(sessionId, account, true));
    await this.#call(
      sessionId,
      (x) => [
        [
          "ContactCard/set",
          {
            accountId: x.accountId,
            create: Object.fromEntries(
              fresh.map((email, j) => {
                const name = (people.get(email) ?? "")
                  .replace(/[\p{Cc}]/gu, " ")
                  .trim()
                  .slice(0, 200);
                return [
                  `a${String(j)}`,
                  newCard(
                    {
                      given: "",
                      surname: "",
                      name,
                      emails: [{ address: email, label: "" }],
                      phones: [],
                      organization: "",
                      notes: "",
                      birthday: null,
                      labels: [],
                    },
                    bookId,
                  ),
                ];
              }),
            ),
          },
          "s",
        ],
      ],
      USING_CONTACTS,
      account,
      { inactive: true },
    );
    await this.#refreshContactRules(sessionId, account);
  }

  // ---- settings (docs/internal/05-webmail.md "Settings") ------------------------------------------------------
  //
  // Mail-flow settings live in the mail server: sender names and signatures on the mailbox's JMAP identities, and
  // automatic replies, forwarding and junk rules in one Sieve script we manage (sieve.ts). Every change takes the
  // account the app is showing and refuses if the session's active mailbox is another one.

  /** Storage used and its limit in bytes (JMAP Quota); `limit` null when there is none. */
  async quota(sessionId: string): Promise<{ used: number; limit: number | null }> {
    const r = await this.#call(
      sessionId,
      (s) => [["Quota/get", { accountId: s.accountId, ids: null }, "q"]],
      USING_QUOTA,
    );
    const list = (r.get("q")?.list ?? []) as {
      resourceType?: string;
      scope?: string;
      used?: number;
      hardLimit?: number | null;
    }[];
    const octets =
      list.find((q) => q.resourceType === "octets" && q.scope === "account") ??
      list.find((q) => q.resourceType === "octets");
    return { used: octets?.used ?? 0, limit: typeof octets?.hardLimit === "number" ? octets.hardLimit : null };
  }

  /**
   * Changes the sender name of one of the mailbox's own identities. Signatures are named signatures now
   * (`mirrorSignature` copies the default into every identity).
   */
  async updateIdentity(
    sessionId: string,
    account: string,
    identityId: string,
    change: { name?: string },
  ): Promise<Identity> {
    this.#identities.delete(account);
    const own = (await this.identities(sessionId)).find((i) => i.id === identityId);
    if (!own) throw new WebmailRefusedError("That address isn't one of yours.");
    const patch: Record<string, string> = {};
    if (change.name !== undefined) patch.name = change.name;
    const r = await this.#call(
      sessionId,
      (x) => [["Identity/set", { accountId: x.accountId, update: { [identityId]: patch } }, "u"]],
      USING_SUBMISSION,
      account,
    );
    this.#identities.delete(account);
    const updated = r.get("u")?.updated as Record<string, unknown> | undefined;
    if (!updated || !(identityId in updated)) throw new WebmailRefusedError("That change wasn't saved.");
    return { ...own, ...(change.name !== undefined ? { name: change.name } : {}) };
  }

  /**
   * The signature the mailbox's identities carry on the mail server from before named signatures (ADR-0014): the
   * mailbox's own address first, then any other address that has one. Plain text, and the HTML when one is set.
   */
  async legacySignature(sessionId: string): Promise<{ text: string; html: string } | null> {
    const s = await this.#ownActive(sessionId);
    const r = await this.#call(
      sessionId,
      (x) => [
        [
          "Identity/get",
          { accountId: x.accountId, ids: null, properties: ["email", "textSignature", "htmlSignature"] },
          "i",
        ],
      ],
      USING_SUBMISSION,
      s.accountId,
    );
    const list = (r.get("i")?.list ?? []) as {
      email: string;
      textSignature?: string | null;
      htmlSignature?: string | null;
    }[];
    const has = (i: (typeof list)[number]) =>
      (i.textSignature ?? "").trim() !== "" || (i.htmlSignature ?? "").trim() !== "";
    const own = s.username.toLowerCase();
    const pick = list.find((i) => i.email.toLowerCase() === own && has(i)) ?? list.find(has);
    return pick ? { text: pick.textSignature ?? "", html: pick.htmlSignature ?? "" } : null;
  }

  /**
   * Copies the default signature for new messages into every one of the mailbox's identities (`htmlSignature` +
   * `textSignature`; empty for none), so other JMAP mail apps and server-side features see it. The HTML was sanitised
   * on save. Returns whether every identity took it.
   */
  async mirrorSignature(
    sessionId: string,
    account: string,
    signature: { html: string; text: string } | null,
  ): Promise<boolean> {
    this.#identities.delete(account);
    const ids = (await this.identities(sessionId)).map((i) => i.id);
    if (ids.length === 0) return true;
    const patch = { htmlSignature: signature?.html ?? "", textSignature: signature?.text ?? "" };
    const r = await this.#call(
      sessionId,
      (x) => [
        ["Identity/set", { accountId: x.accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) }, "u"],
      ],
      USING_SUBMISSION,
      account,
    );
    this.#identities.delete(account);
    const updated = (r.get("u")?.updated ?? {}) as Record<string, unknown>;
    const refused = Object.values((r.get("u")?.notUpdated ?? {}) as Record<string, { type?: unknown }>);
    if (refused.length > 0) {
      const type = refused[0]?.type;
      log.warn("identity signature not saved", { component: "webmail", type: typeof type === "string" ? type : "" });
    }
    return ids.every((id) => id in updated);
  }

  /**
   * The automatic-reply, forwarding and junk settings, and whether they are in force. Read with management
   * credentials (`ManagedSieve`): customer mailboxes can't manage their own Sieve, so the script is ours alone.
   */
  async mailRules(sessionId: string): Promise<{ accountId: string; rules: MailRules; state: RulesState }> {
    const accountId = (await this.#ownActive(sessionId)).accountId;
    const script = await this.#d.sieve.read(accountId);
    if (script === null) return { accountId, rules: DEFAULT_RULES, state: "none" };
    return {
      accountId,
      rules: parseScript(script.content) ?? DEFAULT_RULES,
      state: script.active ? "active" : "inactive",
    };
  }

  /**
   * Writes the managed script with management credentials and makes it the active one. The caller has already
   * checked a forwarding target is the control-plane confirmed one.
   */
  async saveMailRules(
    sessionId: string,
    account: string,
    rules: Omit<MailRules, "include">,
  ): Promise<{ contactsUsed: number }> {
    const s = await this.#ownActive(sessionId);
    if (s.accountId !== account) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    // We own the one script; there is nothing of the person's to include (they can't write Sieve).
    // Forwarding only to the control-plane confirmed target: whoever calls (settings, the contacts refresh) can't
    // keep or set a redirect anywhere else.
    const confirmed = await this.#d.confirmedForward(s.username);
    const forwarding =
      rules.forwarding.enabled && confirmed !== null && rules.forwarding.address === confirmed
        ? { ...rules.forwarding, address: confirmed }
        : { enabled: false, address: null, keepCopy: rules.forwarding.keepCopy };
    const full: MailRules = { ...rules, forwarding, include: null };
    const identities = (await this.identities(sessionId)).map((i) => i.email.toLowerCase());
    const authservIds = this.#d.authservIds();
    const mailboxDomain = s.username.slice(s.username.lastIndexOf("@") + 1).toLowerCase() || null;
    const base = buildScript(full, { identities, contacts: [], authservIds, mailboxDomain });
    let contacts: string[] = [];
    if (usesContacts(full)) {
      const { cards } = await this.#allCards(sessionId, ["emails"], account);
      const addresses = (cards as { emails?: Record<string, { address?: string }> }[]).flatMap((c) =>
        Object.values(c.emails ?? {}).map((e) => e.address ?? ""),
      );
      // Each contact can appear twice (trusted senders and the automatic-reply test).
      contacts = fitContacts(addresses, Math.floor((MAX_SCRIPT_BYTES - Buffer.byteLength(base)) / 2));
    }
    const script = buildScript(full, { identities, contacts, authservIds, mailboxDomain });
    if (new TextEncoder().encode(script).length > MAX_SCRIPT_BYTES) {
      throw new WebmailRefusedError(MAILBOX_RULES_LIMIT_MESSAGE);
    }
    try {
      await this.#d.sieve.write(account, script);
    } catch (err) {
      log.warn("webmail rules not saved", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
      throw new WebmailRefusedError("The mail server didn't accept these settings.");
    }
    return { contactsUsed: contacts.length };
  }

  /**
   * After contacts change: rules that use contacts ("contacts only" replies, "trusted senders only") are rewritten
   * so the script's copy of the addresses follows. Only while our rules are active; best effort, never throws.
   */
  async #refreshContactRules(sessionId: string, account: string): Promise<void> {
    try {
      const { accountId, rules, state } = await this.mailRules(sessionId);
      if (accountId !== account || state !== "active" || !usesContacts(rules)) return;
      const { include: _include, ...rest } = rules;
      await this.saveMailRules(sessionId, account, rest);
    } catch (err) {
      log.warn("webmail rules refresh failed", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  /** Starts the contacts refresh without making the caller wait for it. */
  #afterContactsChange(sessionId: string, account: string): void {
    void this.#refreshContactRules(sessionId, account);
  }
}
