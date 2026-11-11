// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tiers on the customer account (ADR-0034 §1). The account's tier is the one source for every sending path; a
 * mailbox's effective tier is its account's, made stricter by staff's sending restriction of that mailbox (§6).
 */
import type { SuspensionReason } from "@anhourmail/shared/platform";
import { stricterTier, type TrustTier, type TrustTierSource } from "@anhourmail/shared/sending";

import type { AuditAction } from "../audit/catalogue";

/** An account's tier and how it got it. `note` is staff-only: never shown to the customer, logged or audited by value. */
export type AccountTrust = {
  accountId: string;
  tier: TrustTier;
  since: Date;
  source: TrustTierSource;
  /** The reason category staff gave (shown to the customer in plain words), or null. */
  reason: SuspensionReason | null;
  note: string | null;
  /** The staff user id that set it (`source = staff`), or null. */
  setBy: string | null;
  /** The last restriction or staff suspension of the account or one of its people; set, no automatic promotion. */
  lastRestrictedAt: Date | null;
};

/** A tier change as written (`lastRestrictedAt` is kept, and moved only by `markRestricted`). */
export type TrustTierChange = Omit<AccountTrust, "accountId" | "lastRestrictedAt">;

/** Staff's sending restriction of one mailbox. `note` is staff-only, as for the account. */
export type MailboxSendingRestriction = {
  at: Date;
  reason: SuspensionReason;
  note: string | null;
  byUserId: string | null;
};

export type MailboxTrust = {
  mailboxId: string;
  accountId: string;
  address: string;
  restriction: MailboxSendingRestriction | null;
};

/** What the promotion job asks for (ADR-0034 §2); thresholds come from configuration, never published (rule 33). */
export type PromotionCriteria = {
  /** Only accounts created before this. */
  createdBefore: Date;
  /** `trust.send_held` entries at or after this count against the account. */
  heldSince: Date;
  /** Accounts with this many held entries or more are skipped. */
  maxHeld: number;
  limit: number;
};

/** A mailbox's sending facts by address, as stored (the webmail's uncached read, ADR-0034 §3). */
export type MailboxStandingRow = {
  accountId: string;
  mailboxId: string;
  accountTier: TrustTier;
  mailboxRestricted: boolean;
};

/**
 * The audit action recorded when the webmail holds a `new` mailbox's send to an outside address (ADR-0034 §3). The
 * promotion job counts these per account.
 */
export const SEND_HELD_ACTION = "trust.send_held" satisfies AuditAction;

/** A mailbox's effective tier: its account's, or `restricted` while staff restrict the mailbox itself. */
export const effectiveTier = (accountTier: TrustTier, mailboxRestricted: boolean): TrustTier =>
  mailboxRestricted ? stricterTier(accountTier, "restricted") : accountTier;
