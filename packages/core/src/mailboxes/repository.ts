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
   * Sets or clears the webmail's first-sign-in password change (`Mailbox.mustChangePassword`). Cleared by the worker
   * once a password the person chose has reached the mail server, never when the change is only queued.
   */
  setPasswordChangeRequired(id: string, required: boolean): Promise<void>;
  /**
   * Links an unassigned mailbox to a person ("Make this a user"). Conditional: false when the mailbox already belongs
   * to someone (or doesn't exist), so two concurrent links can't both apply.
   */
  assignOwner(id: string, userId: string): Promise<boolean>;
  /** Sets or clears (null) the display name. */
  setDisplayName(id: string, displayName: string | null): Promise<void>;
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

/**
 * A mailbox's password as the control plane hands it to the worker: never the password, only a salted argon2id PHC
 * string waiting to be applied (rule 23), cleared by the worker once the mail server has it.
 */
export type MailboxPasswordRepository = {
  /**
   * Records a new password for the worker to apply, with the web app's grant for replacing it on an existing account
   * (null at creation, or where no grant key is configured); replaces one still waiting. `byOwner`: the mailbox's
   * person chose it themselves, so applying it ends their first-sign-in password change (default false).
   */
  setPending(
    mailboxId: string,
    passwordHash: string,
    grant: string | null,
    opts?: { byOwner?: boolean },
  ): Promise<void>;
  /** Whether a password is waiting for the worker. */
  pending(mailboxId: string): Promise<boolean>;
};

/**
 * Platform-domain addresses that were in use and are gone (a purged mailbox, a deleted masked alias): never handed to
 * a different account (ADR-0021). Kept forever, with no link to the account row, so deleting an account doesn't free
 * its addresses either. Addresses are lowercase.
 */
export type PlatformAddressRepository = {
  /** The account that last held this address, or null if it was never retired. */
  retiredFrom(address: string): Promise<string | null>;
  /** Records that `accountId` held `address` until now; the first record for an address wins (idempotent). */
  retire(address: string, accountId: string, at: Date): Promise<void>;
};
