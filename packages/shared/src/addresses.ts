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
  const forms = [base, letters.replace(/1/g, "i"), letters.replace(/1/g, "l")];
  // "rn" reads as "m" in most fonts (`adrnin`, `rnailer-daemon`).
  return [...new Set([...forms, ...forms.map((f) => f.replace(/rn/g, "m"))])];
}

/**
 * Names nobody may hold even inside a longer name (they'd pass for us, for our system mail, or for an account-security
 * message): checked in every reservation form, so `team-noreply`, `n0reply`, `anhourmail.support` and
 * `your-passwordreset` are all refused.
 */
const RESERVED_FRAGMENTS = [
  "anhourmail",
  "anhourtec",
  "noreply",
  "donotreply",
  "postmaster",
  "hostmaster",
  "mailerdaemon",
  "passwordreset",
  "accountsecurity",
  "trustandsafety",
];

/**
 * Words nobody may start a name with (`support-desk`, `securityteam`, `admin2go`, `official.help`): role and trust
 * words a phishing message would lead with. Checked in every form. `login` is reserved only as a whole name (it starts
 * real surnames such as Loginov); `billing` isn't checked at the end of a name (`jane.billings`).
 */
const RESERVED_PREFIXES = [
  "admin",
  "abuse",
  "security",
  "support",
  "billing",
  "webmaster",
  "helpdesk",
  "verify",
  "verification",
  "confirm",
  "official",
  "password",
  "signin",
  "customerservice",
  "customersupport",
  "customercare",
];

/**
 * Words nobody may end a name with (`team-support`, `bank.security`, `mail-noreply`, `x_official`): the same trust
 * words when they come last. Checked in every form.
 */
const RESERVED_SUFFIXES = [
  "support",
  "security",
  "helpdesk",
  "official",
  "verification",
  "verify",
  "admin",
  "alerts",
  "notifications",
  "accounts",
  "service",
];

/**
 * Names nobody can claim on the platform domain, compared in `reservationForm` (and its look-alike readings). Grouped
 * by why they're held back; staff role addresses on the platform domain come from this list, never from a customer.
 * `svc` followed by `.`, `-` or `_` is reserved as a prefix. Short names (fewer than `PLATFORM_ADDRESS.min`
 * characters) are listed too: the length rule already holds them back, but aliases and staff paths read this list.
 */
const RESERVED = new Set(
  [
    // The mail server's own accounts.
    ...SYSTEM_MAILBOX_LOCAL_PARTS,
    "svc-provision",
    "svc-ops",
    "svc-audit",
    "svc-mgmt",
    // Mail and network infrastructure (RFC 2142 and common practice), and our own hostnames.
    "postmaster",
    "hostmaster",
    "webmaster",
    "abuse",
    "noc",
    "root",
    "mail",
    "email",
    "smtp",
    "imap",
    "pop",
    "pop3",
    "mx",
    "dns",
    "ns",
    "ftp",
    "www",
    "ntp",
    "ldap",
    "autoconfig",
    "autodiscover",
    "mta-sts",
    "webmail",
    "api",
    "app",
    "docs",
    "status",
    "cdn",
    "static",
    "assets",
    "server",
    "host",
    "localhost",
    // Company roles: how people reach a business.
    "admin",
    "administrator",
    "sysadmin",
    "support",
    "help",
    "helpdesk",
    "helpline",
    "hotline",
    "info",
    "information",
    "contact",
    "contactus",
    "hello",
    "enquiries",
    "inquiries",
    "office",
    "reception",
    "service",
    "services",
    "customerservice",
    "customercare",
    "care",
    "sales",
    "billing",
    "accounts",
    "accounting",
    "finance",
    "invoice",
    "invoices",
    "payment",
    "payments",
    "payroll",
    "receipts",
    "refund",
    "refunds",
    "orders",
    "purchasing",
    "procurement",
    "hr",
    "humanresources",
    "jobs",
    "careers",
    "recruiting",
    "recruitment",
    "talent",
    "legal",
    "compliance",
    "privacy",
    "gdpr",
    "dpo",
    "terms",
    "copyright",
    "dmca",
    "trademark",
    "press",
    "media",
    "pr",
    "communications",
    "comms",
    "marketing",
    "partners",
    "partnerships",
    "affiliate",
    "affiliates",
    "investor",
    "investors",
    "ir",
    "board",
    "ceo",
    "cto",
    "cfo",
    "coo",
    "cio",
    "ciso",
    "founder",
    "founders",
    "owner",
    "owners",
    "management",
    "executive",
    "staff",
    "team",
    "employees",
    "everyone",
    "all",
    "community",
    "developer",
    "developers",
    "engineering",
    "devops",
    "it",
    "ops",
    "operations",
    "product",
    "feedback",
    "ideas",
    "suggestions",
    // Automated and system senders.
    "noreply",
    "donotreply",
    "mailer",
    "mailer-daemon",
    "daemon",
    "notification",
    "notifications",
    "notify",
    "alert",
    "alerts",
    "update",
    "updates",
    "announcements",
    "announce",
    "newsletter",
    "newsletters",
    "digest",
    "robot",
    "bot",
    "automated",
    "automation",
    "cron",
    "scheduler",
    "system",
    "monitor",
    "monitoring",
    "uptime",
    "health",
    "test",
    "testing",
    "demo",
    "example",
    "sample",
    "null",
    "nil",
    "nobody",
    "none",
    "undefined",
    "unknown",
    "anonymous",
    "guest",
    "user",
    "username",
    "devnull",
    "blackhole",
    "inbox",
    "mailbox",
    // Security, accounts and trust: what a phishing message would sign as.
    "security",
    "secure",
    "safety",
    "trust",
    "trustandsafety",
    "fraud",
    "phishing",
    "spam",
    "report",
    "reports",
    "verify",
    "verification",
    "verified",
    "validate",
    "validation",
    "confirm",
    "confirmation",
    "auth",
    "authentication",
    "oauth",
    "sso",
    "login",
    "logon",
    "signin",
    "signup",
    "signon",
    "register",
    "registration",
    "password",
    "passwords",
    "passwordreset",
    "reset",
    "recovery",
    "recover",
    "unlock",
    "2fa",
    "mfa",
    "otp",
    "account",
    "accountsecurity",
    "accountservices",
    "official",
    "superuser",
    "moderator",
    "wallet",
    "bank",
    "banking",
    "giveaway",
    "prize",
    "winner",
    "lottery",
    // Mail reports and list conventions.
    "dmarc",
    "dmarc-reports",
    "rua",
    "ruf",
    "tlsrpt",
    "tls-reports",
    "fbl",
    "arf",
    "complaints",
    "unsubscribe",
    "subscribe",
    "list",
    "lists",
    "listserv",
    "listmaster",
    "majordomo",
    "bounce",
    "bounces",
    "return",
    "returns",
    "usenet",
    "news",
    "uucp",
  ].map(reservationForm),
);

/**
 * Reserved on the platform domain (whatever the length): see `RESERVED`, `RESERVED_FRAGMENTS`, `RESERVED_PREFIXES`,
 * `RESERVED_SUFFIXES` and the `svc` prefix. Other companies' names (likely impersonation targets) can't be listed in
 * this public repository (CLAUDE.md rule 57); a private, deploy-time list is a planned follow-up.
 */
export function isReservedPlatformLocalPart(local: string): boolean {
  const v = local.toLowerCase();
  if (/^svc[._-]/.test(v)) return true;
  return reservationForms(v).some(
    (form) =>
      RESERVED.has(form) ||
      RESERVED_FRAGMENTS.some((f) => form.includes(f)) ||
      RESERVED_PREFIXES.some((p) => form.startsWith(p)) ||
      RESERVED_SUFFIXES.some((x) => form.endsWith(x)),
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
