// SPDX-License-Identifier: AGPL-3.0-only
import type { PlanId } from "@anhourmail/shared/plans";
import type { PlatformRole } from "@anhourmail/shared/rbac";

/** One customer account as staff see it: counts and metadata, never mail content. */
export type AccountSummary = {
  id: string;
  name: string;
  plan: PlanId;
  status: string;
  members: number;
  mailboxes: number;
  domains: number;
  createdAt: Date;
};

/** Staff look-up across every customer account (`platform.accounts.read`). Read-only. */
export type PlatformAccountRepository = {
  /**
   * Newest first. `query` matches the account name (contains, case-insensitive), its id exactly, or a member's
   * sign-in email (contains). `total` counts every match.
   */
  search(q: {
    query: string | null;
    limit: number;
    offset: number;
  }): Promise<{ total: number; rows: AccountSummary[] }>;
  summary(id: string): Promise<AccountSummary | null>;
};

/**
 * Platform staff identities, for the one-off first-administrator bootstrap (`bootstrapPlatformAdmin`). Writes only
 * through `mutation()`, so each run is audited in the same transaction.
 */
export type StaffRepository = {
  /** Serialises bootstrap runs until the transaction ends (Postgres: a transaction-scoped advisory lock). */
  lockBootstrap(): Promise<void>;
  /** Whether anyone holds a platform (staff) role of any kind. */
  anyPlatformRole(): Promise<boolean>;
  /**
   * Creates a console login with a verified email and no password: the person sets one through the one-time link.
   * Throws `ConflictError` when a login with the email already exists.
   */
  createLogin(input: { email: string; name: string; firstName: string; lastName: string | null }): Promise<{
    id: string;
  }>;
  grantRole(userId: string, role: PlatformRole, grantedBy: string): Promise<void>;
  /**
   * Stores a single-use set-password token that the console's "Choose a new password" page accepts until `expiresAt`
   * (Postgres: the identity layer's password-reset verification row).
   */
  issuePasswordSetToken(userId: string, token: string, expiresAt: Date): Promise<void>;
};
