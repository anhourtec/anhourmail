// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Published sending limits per trust tier. These are the numbers users see in the docs and console.
 * How an account moves between tiers, and what triggers `restricted`, is internal (docs/internal/03-anti-spam-and-abuse.md)
 * and is never published (CLAUDE.md rule 33). Enforcement is server-side: our checks + Stalwart throttles (rule 27).
 */
import { SYSTEM_MAILBOX_LOCAL_PARTS } from "./addresses";

export type TrustTier = "new" | "standard" | "trusted" | "restricted";

export type SendLimits = {
  /** Messages per rolling 24 hours. */
  messagesPerDay: number;
  /** Messages per rolling hour. */
  messagesPerHour: number;
  /** Recipients (to + cc + bcc) on one message. */
  recipientsPerMessage: number;
};

export type TierInfo = {
  tier: TrustTier;
  label: string;
  description: string;
  limits: SendLimits;
};

export const TRUST_TIERS: Readonly<Record<TrustTier, TierInfo>> = {
  new: {
    tier: "new",
    label: "New",
    description: "Every new account starts here. Limits rise automatically as the account ages in good standing.",
    limits: { messagesPerDay: 25, messagesPerHour: 10, recipientsPerMessage: 10 },
  },
  standard: {
    tier: "standard",
    label: "Standard",
    description: "Accounts in good standing after the first weeks, and every paid account.",
    limits: { messagesPerDay: 200, messagesPerHour: 50, recipientsPerMessage: 50 },
  },
  trusted: {
    tier: "trusted",
    label: "Trusted",
    description: "Long-standing paid accounts with a clean sending history.",
    limits: { messagesPerDay: 1000, messagesPerHour: 200, recipientsPerMessage: 100 },
  },
  restricted: {
    tier: "restricted",
    label: "Restricted",
    description: "Sending is paused while we review unusual activity. Receiving mail keeps working.",
    limits: { messagesPerDay: 0, messagesPerHour: 0, recipientsPerMessage: 0 },
  },
};

/** Every tier, strictest first (the order `stricterTier` uses). */
export const TRUST_TIER_ORDER = ["restricted", "new", "standard", "trusted"] as const satisfies readonly TrustTier[];

export const isTrustTier = (v: unknown): v is TrustTier => typeof v === "string" && Object.hasOwn(TRUST_TIERS, v);

/**
 * The stricter of two tiers: a mailbox's own sending restriction over its account's tier, or the two mailboxes of a
 * delegated send (ADR-0026 §6, ADR-0034 §1).
 */
export function stricterTier(a: TrustTier, b: TrustTier): TrustTier {
  return TRUST_TIER_ORDER.indexOf(a) <= TRUST_TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * How an account got its tier (ADR-0034 §1–2): `default` (never changed), `automatic` (the promotion job, or staff
 * handing it back to the job), `billing` (a paid plan), `staff` (set by hand; the job and billing leave it alone).
 */
export const TRUST_TIER_SOURCES = ["default", "automatic", "billing", "staff"] as const;
export type TrustTierSource = (typeof TRUST_TIER_SOURCES)[number];
export const isTrustTierSource = (v: unknown): v is TrustTierSource =>
  typeof v === "string" && (TRUST_TIER_SOURCES as readonly string[]).includes(v);

/**
 * The tiers staff may set (ADR-0034 §2). `trusted` is reserved: nothing reaches it until the mail server holds per-tier
 * numbers, so setting it is refused (`tier_unavailable`); its published limits stay on the site.
 */
export const STAFF_SETTABLE_TRUST_TIERS = ["new", "standard", "restricted"] as const satisfies readonly TrustTier[];
export type StaffSettableTrustTier = (typeof STAFF_SETTABLE_TRUST_TIERS)[number];
export const isStaffSettableTrustTier = (v: unknown): v is StaffSettableTrustTier =>
  typeof v === "string" && (STAFF_SETTABLE_TRUST_TIERS as readonly string[]).includes(v);

/** The recipients-per-message cap for sessions the mail-server ceiling doesn't cover (port 25; Stalwart's default). */
export const OTHER_RECIPIENTS_PER_MESSAGE = 100;

/**
 * The mail server's one ceiling for every authenticated sender (ADR-0034 §4): the `standard` tier's published numbers,
 * leaving out the deployment's own system accounts on its platform domain (its transactional sender and the reporting
 * addresses, `SYSTEM_MAILBOX_LOCAL_PARTS`), so transactional mail is never throttled by it. Applied by
 * `applySendingPolicy` (`@anhourmail/stalwart-client`) from the dev plan and the deploy's bootstrap; read back by the
 * reconciler.
 */
export function standardSendingPolicy(platformDomain: string) {
  const { messagesPerHour, messagesPerDay, recipientsPerMessage } = TRUST_TIERS.standard.limits;
  return {
    messagesPerHour,
    messagesPerDay,
    recipientsPerMessage,
    otherRecipientsPerMessage: OTHER_RECIPIENTS_PER_MESSAGE,
    exempt: { domain: platformDomain.trim().toLowerCase(), localParts: [...SYSTEM_MAILBOX_LOCAL_PARTS] },
  };
}

/**
 * Bulk and newsletter mail (decision 2026-10-21): never on the base plans; available only through the paid
 * "Newsletters and bulk sending" add-on (planned), which sends from a separate domain and IP pool, requires
 * recorded consent (CASL) and one-click unsubscribe (RFC 8058). Design: docs/internal/11-bulk-sending.md.
 */
export const BULK_MAIL = {
  allowedOnBasePlans: false,
  addOnId: "bulk",
} as const;

/**
 * Attachments in the webmail (published in the docs, enforced by the webmail BFF): per file and per message, in MB
 * (1 MB = 1024 × 1024 bytes). The mail server's own ceiling is higher.
 */
export const WEBMAIL_ATTACHMENTS = {
  perFileMb: 20,
  perMessageMb: 25,
} as const;

/**
 * HTML the webmail sends (published in the docs, enforced by the outgoing sanitiser in the composer and the BFF): the
 * largest HTML body or inserted .html file in MB, and the largest picture embedded in it in KB (1 MB = 1024 KB).
 */
export const WEBMAIL_HTML = {
  maxMb: 1,
  inlineImageKb: 512,
} as const;
