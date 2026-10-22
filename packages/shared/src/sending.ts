// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Published sending limits per trust tier. These are the numbers users see in the docs and console.
 * How an account moves between tiers, and what triggers `restricted`, is internal (docs/internal/03-anti-spam-and-abuse.md)
 * and is never published (CLAUDE.md rule 33). Enforcement is server-side: our checks + Stalwart throttles (rule 27).
 */

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
