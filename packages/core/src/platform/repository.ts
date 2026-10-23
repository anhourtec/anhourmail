// SPDX-License-Identifier: AGPL-3.0-only
import type { PlanId } from "@anhourmail/shared/plans";
import type { SuspensionReason } from "@anhourmail/shared/platform";
import type { PlatformRole } from "@anhourmail/shared/rbac";

import type { Mailbox } from "../mailboxes/entity";

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

/** A staff suspension as recorded (`platform.account.suspend`). `note` is staff-only: never shown to the customer. */
export type SuspensionRecord = {
  reason: SuspensionReason;
  note: string | null;
  at: Date;
  /** The staff member who suspended (user id), or null when unknown. */
  byUserId: string | null;
};

/** Why a mailbox is held suspended by staff: its account is suspended, or the person it belongs to is. */
export type MailboxHoldKind = "account" | "person";

/**
 * Staff suspensions of customer accounts and people, and the mailboxes they hold suspended. A hold marks a mailbox
 * the suspension itself suspended (it was usable before), so lifting resumes exactly those — never one its account
 * had suspended on its own. Writes only through `mutation()` (audited in the same transaction).
 */
export type SuspensionRepository = {
  account(accountId: string): Promise<SuspensionRecord | null>;
  /** Sets (or with null clears) the account's suspension and its status (`suspended` / `active`). */
  setAccount(accountId: string, record: SuspensionRecord | null): Promise<void>;
  /** A console login's sign-in email and name, or null when there is no such login. */
  personInfo(userId: string): Promise<{ email: string; name: string } | null>;
  person(userId: string): Promise<SuspensionRecord | null>;
  /** Sets (or with null clears) the person's suspension (their console sign-in). */
  setPerson(userId: string, record: SuspensionRecord | null): Promise<void>;
  /** Of the person's accounts, those that are suspended. */
  suspendedAccountsOf(userId: string): Promise<string[]>;
  /** Mailboxes assigned to the person, in every account. */
  mailboxesOf(userId: string): Promise<Mailbox[]>;
  /** The holds on these mailboxes. */
  holds(mailboxIds: readonly string[]): Promise<{ mailboxId: string; kind: MailboxHoldKind }[]>;
  /** Adds a hold (idempotent). */
  addHold(mailboxId: string, kind: MailboxHoldKind): Promise<void>;
  removeHold(mailboxId: string, kind: MailboxHoldKind): Promise<void>;
};
