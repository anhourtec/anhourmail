// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountTrust,
  MailboxSendingRestriction,
  MailboxStandingRow,
  MailboxTrust,
  PromotionCriteria,
  TrustTierChange,
} from "./entity";

/**
 * Trust tiers (ADR-0034): the account's tier and its mailboxes' sending restrictions. Every read and write is scoped
 * to one account; a mailbox of another account reads as null and is never changed. Services lock the account
 * (`accounts.lock`) before a change.
 */
export type TrustRepository = {
  /** The account's tier, or null for an unknown id. */
  get(accountId: string): Promise<AccountTrust | null>;
  /** Writes the tier and its since, source, reason, note and setter. False when the account doesn't exist. */
  setTier(accountId: string, change: TrustTierChange): Promise<boolean>;
  /** Moves `last_restricted_at` to `at` unless it is already later. */
  markRestricted(accountId: string, at: Date): Promise<void>;
  /**
   * Accounts the promotion job may move from `new` to `standard`, oldest first: source not `staff`, created before
   * `createdBefore`, not suspended and no person of it suspended, billing not `restricted` or `lapsed`, at least one
   * owner and every owner's email confirmed, never restricted, and fewer than `maxHeld` `trust.send_held` entries in
   * its log since `heldSince`.
   */
  promotionCandidates(criteria: PromotionCriteria): Promise<{ accountId: string; createdAt: Date }[]>;
  /**
   * Whether one account meets every `promotionCandidates` condition now (false for an unknown id). The promotion job
   * asks again under the account lock, so a change made since the list was read is never promoted past.
   */
  qualifiesForPromotion(accountId: string, criteria: Omit<PromotionCriteria, "limit">): Promise<boolean>;
  /** The account's mailboxes with their sending restrictions, by address. */
  mailboxes(accountId: string): Promise<MailboxTrust[]>;
  /** One mailbox of the account, or null when it isn't one (another account's id reads as unknown). */
  mailbox(accountId: string, mailboxId: string): Promise<MailboxTrust | null>;
  /** Sets or clears a mailbox's restriction; false (and nothing changed) when the mailbox isn't the account's. */
  setMailboxRestriction(
    accountId: string,
    mailboxId: string,
    restriction: MailboxSendingRestriction | null,
  ): Promise<boolean>;
  /** A mailbox's sending facts by its address (lowercase), or null when we don't hold the address. */
  standingByAddress(address: string): Promise<MailboxStandingRow | null>;
};
