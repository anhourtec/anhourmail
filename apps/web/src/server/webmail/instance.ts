// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { db, pgMailboxStatusLookup } from "@anhourmail/adapters/postgres";
import {
  authorizeDelegatedSend,
  delegatedMailboxesFor,
  delegatedSendCheck,
  delegationCheck,
  DelegationGate,
  MailboxAccessGate,
  openDelegatedMailbox,
  PasswordChangeGate,
  recordDelegatedSendOutcome,
  webmailAccess,
  WebmailSettingsService,
  WebmailSignaturesService,
} from "@anhourmail/core/webmail";
import { setWebmailSenderName, webmailSenderName, webmailSendingNames } from "@anhourmail/core/people";
import { keyRingFromEnv } from "@anhourmail/server/keyring";
import { type FailureStore, redisFailureStore, redisSlidingQuota } from "@anhourmail/server/rate-limit";
import { redis } from "@anhourmail/server/redis";

import { managedSieve } from "../adapters/stalwart";
import { stalwartHandoffSignIn, stalwartOAuthPort } from "../adapters/stalwart-oauth";
import { container } from "../container";
import { env, senderDelegationKey } from "../env";
import { platform } from "../platform";
import { trustedAuthservIds } from "./original";
import { type SessionKv, WebmailSessionStore } from "./session-store";
import { type OAuthPort, WebmailService } from "./service";
import { WebmailSettings } from "./settings";
import { WEBMAIL_COOKIE_NAMES } from "../host-routing";
import { timed } from "../http/server-timing";

/**
 * The webmail session cookie (ADR-0003): opaque id only, HttpOnly, SameSite=Lax, host-only. On https it is
 * `__Host-` prefixed and Secure; in dev (http, ports share one cookie jar) it still has its own name, distinct from
 * the console's `am.session_token`.
 */
export function webmailCookieName(): string {
  const [secure, dev] = WEBMAIL_COOKIE_NAMES;
  return env().WEBMAIL_URL.startsWith("https://") ? secure : dev;
}

export function webmailCookie(value: string, maxAgeSec: number): string {
  const secure = env().WEBMAIL_URL.startsWith("https://");
  return [
    `${webmailCookieName()}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(maxAgeSec)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The webmail session id from a Cookie header (route handlers). */
export function webmailSessionId(cookieHeader: string | null): string | null {
  const name = webmailCookieName().replace(/[.]/g, "\\.");
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader ?? "");
  return m?.[1] ?? null;
}

/** Compare-and-set for session records (see `SessionKv.cas`): atomic in Redis. */
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local v = string.match(cur, '^(%d+)%.') or '0'
if v ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

const redisKv = (): SessionKv => ({
  get: (k) => redis().get(k),
  set: async (k, v, ttl, mode) => {
    if (mode === "update") return (await redis().set(k, v, "EX", ttl, "XX")) !== null;
    await redis().set(k, v, "EX", ttl);
    return true;
  },
  cas: async (k, expected, v, ttl) => Number(await redis().eval(CAS_SCRIPT, 1, k, expected, v, ttl)) === 1,
  del: async (k) => {
    await redis().del(k);
  },
});

let failureStore: FailureStore | null = null;

/** Wrong-password counts per address (failure-only limit; Redis). */
export function webmailFailures(): FailureStore {
  failureStore ??= redisFailureStore(redis());
  return failureStore;
}

let accessGate: MailboxAccessGate | null = null;
/** Whether a mailbox may use the webmail now (control plane, cached ≤ 30 s); shared by the BFF and `route()`. */
export function mailboxAccessGate(): MailboxAccessGate {
  if (!accessGate) {
    const lookup = pgMailboxStatusLookup(db());
    accessGate = new MailboxAccessGate((address) => timed("db", () => lookup(address)));
  }
  return accessGate;
}

let delegationGateInstance: DelegationGate | null = null;
/**
 * The delegation gate (ADR-0026 §6): every use of a delegated mailbox asks core for the grant now ("has the right"
 * cached ≤ 10 s per session and mailbox). Its mailbox checks use the access lookup uncached.
 */
export function delegationGate(): DelegationGate {
  if (!delegationGateInstance) {
    const lookup = pgMailboxStatusLookup(db());
    const check = delegationCheck(container().deps, { state: async (address) => webmailAccess(await lookup(address)) });
    delegationGateInstance = new DelegationGate((entry) => timed("db", () => check(entry)));
  }
  return delegationGateInstance;
}

/** The OAuth port with its token refreshes timed (`Server-Timing` `refresh`). */
const timedRefresh = (port: OAuthPort): OAuthPort => ({
  signIn: (name, secret) => port.signIn(name, secret),
  refresh: (token) => timed("refresh", () => port.refresh(token)),
});

let instance: WebmailService | null = null;

/** The webmail BFF service (lazy, one per server process; rebuilt when this module reloads in dev). */
export function webmail(): WebmailService {
  if (!instance) {
    const e = env();
    const stalwartUrl = e.STALWART_URL;
    if (!stalwartUrl) throw new Error("STALWART_URL is not set");
    const ring = keyRingFromEnv({
      spec: e.SECRETS_KEYRING,
      production: e.NODE_ENV === "production",
      devFallbackSecret: e.BETTER_AUTH_SECRET,
    });
    instance = new WebmailService({
      store: new WebmailSessionStore(redisKv(), ring),
      oauth: timedRefresh(
        stalwartOAuthPort({
          stalwartUrl,
          webmailUrl: e.WEBMAIL_URL,
          // Dev: a visitor without a forwarded address is this machine (servers bind to loopback by default).
          fallbackIp: e.NODE_ENV === "production" ? null : "127.0.0.1",
        }),
      ),
      // Console → webmail handoff (ADR-0024): a throwaway credential minted with the operations key, used once.
      handoffSignIn: stalwartHandoffSignIn({
        stalwartUrl,
        webmailUrl: e.WEBMAIL_URL,
        fallbackIp: e.NODE_ENV === "production" ? null : "127.0.0.1",
      }),
      // A handoff-born webmail session ends with its console session (ADR-0024).
      consoleSessionAlive: (userId, sessionId) =>
        timed("db", async () =>
          (await container().deps.uow.run((r) => r.security.sessions(userId, new Date()))).some(
            (x) => x.id === sessionId,
          ),
        ),
      // Delegated mailboxes (ADR-0026): listed and opened by core, used only through the gate.
      delegation: {
        list: (owners) => delegatedMailboxesFor(container().deps, owners),
        open: (input, signIn, req) => {
          const lookup = pgMailboxStatusLookup(db());
          return openDelegatedMailbox(
            container().deps,
            { state: async (address) => webmailAccess(await lookup(address)) },
            input,
            signIn,
            req,
          );
        },
        gate: delegationGate(),
        // Sending from one (ADR-0026 §6, §8): the send right checked now and audited before the submission.
        authorizeSend: (input, req) => {
          const lookup = pgMailboxStatusLookup(db());
          return authorizeDelegatedSend(
            container().deps,
            { state: async (address) => webmailAccess(await lookup(address)) },
            input,
            req,
          );
        },
        checkSend: (input) => {
          const lookup = pgMailboxStatusLookup(db());
          return delegatedSendCheck(
            container().deps,
            { state: async (address) => webmailAccess(await lookup(address)) },
            input,
          );
        },
        sendOutcome: (input, outcome, req) => recordDelegatedSendOutcome(container().deps, input, outcome, req),
      },
      // The send-on-behalf key, read at use (production requires it at start-up; never in the worker).
      onBehalfKey: senderDelegationKey,
      stalwartUrl,
      access: mailboxAccessGate(),
      quota: redisSlidingQuota(redis()),
      // The undo-send hold each mailbox chose in its settings.
      holdSeconds: async (address) => (await settingsService().preferences(address)).undoSeconds,
      // The managed Sieve script is written with management credentials (internal network only, rule 21), never
      // the user's token: customer mailboxes can't manage their own Sieve (CUSTOMER_PERMISSIONS).
      sieve: managedSieve(),
      // The one source for the sender name (rule 61): what the identities are named and what mail is sent as; the
      // mailbox's masked aliases send with no name.
      senderName: (address) => webmailSendingNames(container().deps, address),
      confirmedForward: async (address) => {
        const f = await settingsService().forwarding(address);
        return f?.status === "confirmed" ? f.address : null;
      },
      authservIds: () => {
        const e = env();
        return trustedAuthservIds(e.MAIL_AUTHSERV_ID, platform().hosts.mx, e.NODE_ENV === "production");
      },
    });
  }
  return instance;
}

let passwordGate: PasswordChangeGate | null = null;
/** Whether a mailbox must change its password before using the webmail (`./password-gate`). */
export function passwordChangeGate(): PasswordChangeGate {
  passwordGate ??= new PasswordChangeGate((address) =>
    timed(
      "db",
      async () =>
        (await container().deps.uow.run((r) => r.webmailSettings.mailboxByAddress(address)))?.mustChangePassword ===
        true,
    ),
  );
  return passwordGate;
}

let settingsCore: WebmailSettingsService | null = null;
/** Control-plane webmail settings (preferences, forwarding confirmation, audit). */
export function settingsService(): WebmailSettingsService {
  settingsCore ??= new WebmailSettingsService(container().deps);
  return settingsCore;
}

let settingsInstance: WebmailSettings | null = null;
/** Webmail settings: control plane + mail server, for the session's own mailbox. */
export function webmailSettings(): WebmailSettings {
  settingsInstance ??= new WebmailSettings({
    mail: webmail(),
    settings: settingsService(),
    signatures: new WebmailSignaturesService(container().deps),
    senderNames: {
      get: (address) => webmailSenderName(container().deps, address),
      set: (address, input, req) => setWebmailSenderName(container().deps, address, input, req),
    },
    mailer: container().mailer,
    webmailUrl: env().WEBMAIL_URL,
    siteHost: platform().hosts.site,
  });
  return settingsInstance;
}
