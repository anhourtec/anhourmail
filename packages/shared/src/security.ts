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

/**
 * Hours a "confirm your email address" link works (sent at sign-up and on request from the console). Confirming it is
 * what a free platform address needs (ADR-0021). The docs render it (`<Value of="emailVerificationHours" />`).
 */
export const EMAIL_VERIFICATION_HOURS = 24;

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

// --- breached passwords (docs/internal/07-security.md "Breached-password check") -----------------------------------

/**
 * Every new console or mailbox password is checked against the public breached-password corpus, server-side, with the
 * k-anonymity range lookup (only the first five characters of the password's SHA-1 hash leave our server). A match is
 * refused with this message and error code (console API: `PASSWORD_BREACHED`, as better-auth spells its codes).
 */
export const BREACHED_PASSWORD = {
  code: "password_breached",
  authCode: "PASSWORD_BREACHED",
  message: "This password has appeared in a data breach. Choose a different one.",
  /** The lookup gives up after this long and lets the password through (fail open; the check is advisory). */
  timeoutMs: 2000,
} as const;

// --- mailbox passwords (webmail and mail apps; docs/internal/07-security.md "Mailbox passwords") ------------------

/**
 * A mailbox password: what a person types to sign in to the webmail (and, with an app password for everything else,
 * what their mail apps never need). Same length rule as console passwords (12+), plus what would break sign-in: no
 * leading or trailing spaces (mail apps trim them), nothing that starts like an app password (`app_`, which the
 * webmail sign-in refuses), no control characters, and not the address itself.
 */
export const MAILBOX_PASSWORD = { min: 12, max: 128 } as const;

/** The requirements as the forms show them (one line each). */
export const MAILBOX_PASSWORD_RULES: readonly string[] = [
  `${String(MAILBOX_PASSWORD.min)} to ${String(MAILBOX_PASSWORD.max)} characters. A passphrase works well.`,
  "No spaces at the start or end.",
  "Not the mailbox address, and not starting with app_.",
];

/** Why `password` can't be a mailbox password for `address` (one sentence for the form), or null when it's fine. */
export function mailboxPasswordProblem(password: string, address: string): string | null {
  const chars = Array.from(password).length; // code points, as people count them
  if (chars < MAILBOX_PASSWORD.min) {
    return `Use at least ${String(MAILBOX_PASSWORD.min)} characters for the password.`;
  }
  if (chars > MAILBOX_PASSWORD.max) return `Use at most ${String(MAILBOX_PASSWORD.max)} characters for the password.`;
  if (password.trim() !== password) return "Remove the spaces at the start or end of the password.";
  if (/\p{Cc}/u.test(password)) return "The password can't contain control characters.";
  if (/^app_/i.test(password)) return "Mailbox passwords can't start with app_ (that's how app passwords start).";
  const lower = password.toLowerCase();
  const addr = address.trim().toLowerCase();
  const local = addr.slice(0, addr.lastIndexOf("@"));
  if (lower === addr || (local !== "" && lower === local)) return "Choose a password that isn't the mailbox address.";
  return null;
}

/**
 * The only mailbox-password hash we hand on: argon2id v19 at exactly our parameters (m=19456 KiB, t=2, p=1) with a
 * bounded salt and hash (base64, as `@node-rs/argon2` writes them). The management proxy and the Stalwart client
 * check the same shape.
 */
export const MAILBOX_PASSWORD_PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{16,64}\$[A-Za-z0-9+/]{32,128}$/;

/** "Generate a strong password": length and alphabet (no look-alikes such as l, 1, O, 0): 56 symbols, ~116 bits. */
export const GENERATED_MAILBOX_PASSWORD = {
  length: 20,
  alphabet: "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",
} as const;

/**
 * A strong mailbox password from the browser's (or Node's) cryptographic random source: `GENERATED_MAILBOX_PASSWORD`
 * length from its alphabet, without modulo bias (bytes ≥ the largest multiple of the alphabet size are drawn again).
 */
export function generateMailboxPassword(
  fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) => globalThis.crypto.getRandomValues(b),
): string {
  const { alphabet, length } = GENERATED_MAILBOX_PASSWORD;
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of fill(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet.charAt(byte % alphabet.length);
    }
  }
  return out;
}
