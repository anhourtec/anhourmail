// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Free addresses on the platform domain (`name@anhourmail.com`; ADR-0021). One validator for the console form and the
 * server, and the numbers the public docs render (CLAUDE.md rule 32). Customer domains keep their own, looser rules
 * (core `normaliseLocalPart`): these apply only to the shared platform domain, where every name is first come, first
 * served across all accounts.
 */

/**
 * Length of a platform-domain local part. One to three characters are held back: short names are scarce and the first
 * thing squatters take. The docs render both numbers (`<Value of="platformAddressMin" />`, `platformAddressMax`).
 */
export const PLATFORM_ADDRESS = { min: 4, max: 32 } as const;

/**
 * The mail server's own accounts on the platform (system) domain: the owners of the management keys (`svc-*`), the
 * transactional sender and the RFC 2142 / reporting addresses the deployment publishes. Never a customer mailbox, so
 * the reconciler expects them there and nobody can claim them.
 */
export const SYSTEM_MAILBOX_LOCAL_PARTS: readonly string[] = [
  "no-reply",
  "postmaster",
  "abuse",
  "dmarc-reports",
  "tls-reports",
];

/** A system account local part: `svc-` anything (service accounts) or one of `SYSTEM_MAILBOX_LOCAL_PARTS`. */
export function isSystemLocalPart(local: string): boolean {
  const v = local.toLowerCase();
  return v.startsWith("svc-") || SYSTEM_MAILBOX_LOCAL_PARTS.includes(v);
}

/**
 * The form a name is compared in for reservation: lowercase, without `.`, `-` and `_`, and without trailing digits —
 * so `no.reply`, `no_reply`, `noreply1`, `post.master` and `admin2` all read as the reserved name they imitate.
 */
export function reservationForm(local: string): string {
  return local
    .toLowerCase()
    .replace(/[._-]/g, "")
    .replace(/^[0-9]+|[0-9]+$/g, "");
}

/** Digits read as the letters they imitate (`n0reply`, `adm1n`, `s3curity`); `1` is tried as both `i` and `l`. */
const LOOK_ALIKE: Readonly<Record<string, string>> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t" };

/** The reservation form, plus its look-alike readings with digits taken as letters. */
function reservationForms(local: string): string[] {
  const base = reservationForm(local);
  const letters = base.replace(/[03457]/g, (d) => LOOK_ALIKE[d] ?? d);
  return [...new Set([base, letters.replace(/1/g, "i"), letters.replace(/1/g, "l")])];
}

/**
 * Names nobody may hold even inside a longer name (they'd pass for us or for our system mail): checked in every
 * reservation form, so `team-noreply`, `n0reply` and `anhourmail.support` are all refused.
 */
const RESERVED_FRAGMENTS = ["anhourmail", "anhourtec", "noreply", "postmaster", "mailerdaemon"];

/** Role words nobody may start a name with (`support-desk`, `securityteam`, `admin2go`): checked in every form. */
const RESERVED_PREFIXES = [
  "admin",
  "abuse",
  "security",
  "support",
  "billing",
  "hostmaster",
  "webmaster",
  "verify",
  "verification",
];

/**
 * Names nobody can claim on the platform domain: role addresses (RFC 2142, list and report addresses), names that would
 * pass for us or for staff, and the system accounts. Compared in `reservationForm` (and its look-alike readings); `svc` followed by `.`, `-` or `_` is
 * reserved as a prefix, names containing a `RESERVED_FRAGMENTS` entry or starting with a `RESERVED_PREFIXES` entry
 * are refused.
 */
const RESERVED = new Set(
  [
    ...SYSTEM_MAILBOX_LOCAL_PARTS,
    "svc-provision",
    "svc-ops",
    "svc-audit",
    "svc-mgmt",
    "admin",
    "administrator",
    "root",
    "hostmaster",
    "webmaster",
    "security",
    "support",
    "help",
    "helpdesk",
    "info",
    "billing",
    "sales",
    "marketing",
    "privacy",
    "legal",
    "noreply",
    "mailer-daemon",
    "staff",
    "team",
    "system",
    "usenet",
    "news",
    "uucp",
    "verify",
    "verification",
    "notifications",
    "accounts",
    "bounce",
    "bounces",
    "dmarc",
    "tlsrpt",
  ].map(reservationForm),
);

/** Reserved on the platform domain (whatever the length): see `RESERVED`, `RESERVED_FRAGMENTS` and the `svc` prefix. */
export function isReservedPlatformLocalPart(local: string): boolean {
  const v = local.toLowerCase();
  if (/^svc[._-]/.test(v)) return true;
  return reservationForms(v).some(
    (form) =>
      RESERVED.has(form) ||
      RESERVED_FRAGMENTS.some((f) => form.includes(f)) ||
      RESERVED_PREFIXES.some((p) => form.startsWith(p)),
  );
}

/**
 * What's wrong with a platform-domain local part, in words a person can act on, or null when it's fine (format only:
 * whether it's free is a server question). Lowercase letters, digits, `.`, `-` and `_`; starts and ends with a letter
 * or digit; no `..`; `PLATFORM_ADDRESS.min`–`max` characters; not reserved. The input is trimmed and lowercased first,
 * as the server does.
 */
export function platformLocalPartProblem(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v.length < PLATFORM_ADDRESS.min) {
    return `Use at least ${String(PLATFORM_ADDRESS.min)} characters.`;
  }
  if (v.length > PLATFORM_ADDRESS.max) {
    return `Use at most ${String(PLATFORM_ADDRESS.max)} characters.`;
  }
  if (!/^[a-z0-9._-]+$/.test(v)) {
    return "Use lowercase letters, numbers, dots, hyphens or underscores.";
  }
  if (!/^[a-z0-9]/.test(v) || !/[a-z0-9]$/.test(v)) {
    return "Start and end with a letter or a number.";
  }
  if (v.includes("..")) return "Don't use two dots in a row.";
  if (isReservedPlatformLocalPart(v)) return "That name is reserved.";
  return null;
}
