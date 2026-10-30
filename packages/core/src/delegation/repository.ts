// SPDX-License-Identifier: AGPL-3.0-only
import type { DelegationGrant, DelegationRight } from "./entity";

/**
 * Mailbox delegation grants (ADR-0026). Every read and write is scoped to the account, so another account's mailbox or
 * person is simply not found. Lists are ordered by right (`DELEGATION_RIGHTS` order), then oldest first.
 */
export type DelegationRepository = {
  /** Every grant on one mailbox of the account. */
  listForMailbox(accountId: string, mailboxId: string): Promise<DelegationGrant[]>;
  /** Every grant one person holds in the account, on any of its mailboxes. */
  listForGrantee(accountId: string, userId: string): Promise<DelegationGrant[]>;
  /** The rights a person holds on a mailbox now (empty when none, or when either isn't in the account). */
  rightsOf(accountId: string, mailboxId: string, userId: string): Promise<DelegationRight[]>;
  /**
   * Records a grant. Idempotent: false when the person already holds that right on the mailbox. The caller has
   * checked that the mailbox and the person are in the account (the database refuses a person who isn't).
   */
  grant(input: {
    accountId: string;
    mailboxId: string;
    granteeUserId: string;
    right: DelegationRight;
    grantedBy: string | null;
    at: Date;
  }): Promise<boolean>;
  /** Deletes one grant. Conditional: false when it wasn't held. */
  revoke(accountId: string, mailboxId: string, granteeUserId: string, right: DelegationRight): Promise<boolean>;
  /** Deletes every grant on a mailbox (it is being deleted) and returns what it deleted. */
  revokeAllForMailbox(accountId: string, mailboxId: string): Promise<DelegationGrant[]>;
  /** Deletes every grant a person holds in the account (they are leaving it) and returns what it deleted. */
  revokeAllForGrantee(accountId: string, userId: string): Promise<DelegationGrant[]>;
};
