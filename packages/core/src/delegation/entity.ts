// SPDX-License-Identifier: AGPL-3.0-only
import type { DelegationRight } from "@anhourmail/shared/delegation";

export type { DelegationRight };

/**
 * One right one person holds on one mailbox of the same account (ADR-0026). A grant changes nothing on the mail server:
 * the webmail BFF checks the grant table on every request, so a grant works as soon as it commits and a revoke (the row
 * is deleted; the history is the audit log) stops the next request.
 */
export type DelegationGrant = {
  id: string;
  accountId: string;
  mailboxId: string;
  /** A member of the account (never the mailbox's own person). */
  granteeUserId: string;
  right: DelegationRight;
  /** The console user who granted it; null when the system wrote it. */
  grantedBy: string | null;
  createdAt: Date;
};

/** Why a grant went away (audit meta `reason`). */
export type DelegationRevokeReason = "admin" | "member_removed" | "mailbox_deleted" | "became_owner" | "role_changed";
