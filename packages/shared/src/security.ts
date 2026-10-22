// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console sign-in security facts (docs/internal/07-security.md "Sign-in factors"). One source for the console, the
 * public docs and the tests (CLAUDE.md rule 32).
 */

/** What an account's Owners can require of everyone in the account before they reach the console. */
export const SIGN_IN_POLICIES = ["none", "two_factor", "passkey"] as const;
export type SignInPolicy = (typeof SIGN_IN_POLICIES)[number];

export const SIGN_IN_POLICY_LABELS: Readonly<Record<SignInPolicy, string>> = {
  none: "No extra requirement",
  two_factor: "Two-factor sign-in (authenticator app or passkey)",
  passkey: "A passkey or security key",
};

export const isSignInPolicy = (v: unknown): v is SignInPolicy =>
  typeof v === "string" && (SIGN_IN_POLICIES as readonly string[]).includes(v);

/** Authenticator apps: RFC 6238, SHA-1, 6 digits, 30-second steps (what every common app supports). */
export const TOTP = { digits: 6, periodSeconds: 30 } as const;

/** Recovery codes: how many are issued at once, and when the console starts warning that few are left. */
export const RECOVERY_CODES = { count: 10, warnAtOrBelow: 3 } as const;

/** "Trust this device": how long a browser skips the second step after a successful one. */
export const TRUSTED_DEVICE_DAYS = 30;

/** Wrong second-step codes: per sign-in attempt, then per account (the account is locked for a while). */
export const SECOND_STEP_LIMITS = { perChallenge: 5, perAccount: 10, lockMinutes: 15, challengeMinutes: 10 } as const;

/** Passkey names people choose ("Work laptop"). */
export const PASSKEY_NAME_MAX = 60;

/** How a console session was signed in (recorded on the session; an account requirement can depend on it). */
export const SIGN_IN_METHODS = [
  "password",
  "password+trusted_device",
  "password+totp",
  "password+recovery_code",
  "passkey",
] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
export const isSignInMethod = (v: unknown): v is SignInMethod =>
  typeof v === "string" && (SIGN_IN_METHODS as readonly string[]).includes(v);

/** Adding a passkey needs the person to have confirmed it's them (password or a code) this recently. */
export const STEP_UP_MINUTES = 5;

// --- app passwords (mail apps over IMAP, POP3, SMTP and HTTPS; docs/internal/07-security.md "App passwords") ------

/**
 * What an app password may be used for. Each one is an allow-list of mail-server permissions; everything else is off
 * (`@anhourmail/stalwart-client` `SCOPE_ALLOW`): `imap` and `pop3` reading mail, `smtp` sending, `jmap` mail over
 * HTTPS (reading and sending in JMAP apps), `dav` contacts and calendars (CardDAV, CalDAV and their JMAP objects).
 */
export const APP_PASSWORD_PROTOCOLS = ["imap", "pop3", "smtp", "jmap", "dav"] as const;
export type AppPasswordProtocol = (typeof APP_PASSWORD_PROTOCOLS)[number];

export const APP_PASSWORD_PROTOCOL_LABELS: Readonly<Record<AppPasswordProtocol, { label: string; hint: string }>> = {
  imap: { label: "Read mail (IMAP)", hint: "Mail apps that keep folders in sync. Most apps use this." },
  pop3: { label: "Download mail (POP3)", hint: "Older apps that download mail to one device." },
  smtp: { label: "Send mail (SMTP)", hint: "Sending from the app, a printer or a script." },
  jmap: { label: "Mail over HTTPS (JMAP)", hint: "JMAP mail apps: read and send mail over HTTPS." },
  dav: { label: "Contacts and calendars", hint: "CardDAV and CalDAV apps over HTTPS." },
};

/** Ticked for a new app password: what a phone or desktop mail app needs. POP3 is opt-in. */
export const APP_PASSWORD_DEFAULT_PROTOCOLS: readonly AppPasswordProtocol[] = ["imap", "smtp", "dav"];

export const isAppPasswordProtocol = (v: unknown): v is AppPasswordProtocol =>
  typeof v === "string" && (APP_PASSWORD_PROTOCOLS as readonly string[]).includes(v);

/**
 * App passwords per mailbox. Matches the mail server's own default ceiling (`maxAppPasswords`, 5 on the pinned
 * Stalwart), so the console never offers one the server would refuse. The docs render it (`appPasswordsPerMailbox`).
 */
export const APP_PASSWORDS_PER_MAILBOX = 5;

/** App password names people choose ("Phone", "Work laptop"). */
export const APP_PASSWORD_NAME_MAX = 40;
