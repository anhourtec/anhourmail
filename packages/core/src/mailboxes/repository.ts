// SPDX-License-Identifier: AGPL-3.0-only
import type { Mailbox, MailboxStatus } from "./entity";

/** Mailboxes. Reads are scoped to the owning account, so another account's ids are simply not found. */
export type MailboxRepository = {
  listByAccount(accountId: string): Promise<Mailbox[]>;
  get(accountId: string, id: string): Promise<Mailbox | null>;
  count(accountId: string): Promise<number>;
  /** Used by any mailbox or alias, in any account (addresses are global). */
  addressTaken(address: string): Promise<boolean>;
  /**
   * Holds the address until the transaction ends, so a concurrent mailbox or alias create can't pass the
   * `addressTaken` check for the same address (mailboxes and aliases are separate tables).
   */
  lockAddress(address: string): Promise<void>;
  insert(mailbox: Mailbox): Promise<void>;
  setQuota(id: string, quotaBytes: number): Promise<void>;
  /**
   * Moves a mailbox from one of `from` to `to` (suspend, resume, schedule deletion, restore), sets `purgeAfter` and
   * clears `lastError` (a new intent).
   * Conditional, so two concurrent changes can't both apply: returns false if the status was no longer in `from`.
   */
  transition(id: string, from: readonly MailboxStatus[], to: MailboxStatus, purgeAfter: Date | null): Promise<boolean>;
  /** Mailboxes in any account whose grace period has ended (`deleting` with `purgeAfter <= now`), oldest first. */
  dueForPurge(now: Date, limit: number): Promise<Mailbox[]>;
  /**
   * Deletes a mailbox row and its aliases, only if it is still `deleting` and due at `now` (a restore wins).
   * Returns whether it deleted anything.
   */
  deleteIfDue(id: string, now: Date): Promise<boolean>;
};
