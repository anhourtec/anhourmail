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

/**
 * Why a mailbox is held suspended: staff suspended its account (`account`) or its person (`person`), or its account is
 * waiting to be deleted (`deletion`, ADR-0025). It resumes only once no hold is left.
 */
export type MailboxHoldKind = "account" | "person" | "deletion";

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

/** Why an act-as session ended (ADR-0023): staff ended it, it ran out, its console session ended, or the role went. */
/**
 * Why a session ended: the staff member ended it, it ran out, its console session ended, the staff member lost the
 * role, or someone in the account became staff meanwhile (rule 28).
 */
export type ActAsEndReason = "staff" | "expired" | "signed_out" | "role_removed" | "staff_account";

/** A staff act-as session (ADR-0023). `reason` is the staff member's own words; the account's admins see it. */
export type ActAsSession = {
  id: string;
  staffUserId: string;
  staffEmail: string;
  /** The staff role that allowed it, when it started. */
  staffRole: PlatformRole;
  /** The console session it belongs to: other sessions of the same person stay in the staff view. */
  authSessionId: string;
  accountId: string;
  accountName: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: ActAsEndReason | null;
};

/**
 * Staff act-as sessions (ADR-0023). A session is open while it isn't ended and `expiresAt` is after now. Writes only
 * through `mutation()` (audited in the same transaction). Rows are kept after they end (who opened what, and when).
 */
export type ActAsRepository = {
  /** The open session bound to this console session of this staff member, or null. */
  active(staffUserId: string, authSessionId: string, now: Date): Promise<ActAsSession | null>;
  /** Any open session of this staff member (whichever console session holds it). */
  openFor(staffUserId: string, now: Date): Promise<ActAsSession | null>;
  get(id: string): Promise<ActAsSession | null>;
  /**
   * True when someone in the account holds a platform role or signs in with a company address or one of its
   * subdomains (rule 28). One query: checked on every request while acting.
   */
  staffInAccount(accountId: string): Promise<boolean>;
  /**
   * Stores a new session. At most one per staff member may be unclosed (`ended_at` null; Postgres enforces it with a
   * partial unique index): a second throws `ConflictError` with `ACT_AS_ALREADY_OPEN`, so concurrent starts can't
   * both succeed.
   */
  create(input: {
    staffUserId: string;
    staffRole: PlatformRole;
    authSessionId: string;
    accountId: string;
    reason: string;
    startedAt: Date;
    expiresAt: Date;
  }): Promise<ActAsSession>;
  /** Moves an open session's expiry and reason (renewal); false when it is no longer open. */
  renew(id: string, expiresAt: Date, reason: string, now: Date): Promise<boolean>;
  /** Ends a session that isn't ended yet; false when it already was (a concurrent end). */
  end(id: string, at: Date, reason: ActAsEndReason): Promise<boolean>;
  /**
   * Sessions not yet marked ended that must be: past their expiry, whose console session is gone, whose staff member
   * no longer holds one of `roles`, or whose account now has staff in it. Oldest first, at most `limit`; only
   * `staffUserId`'s when given. `reason` is the first that applies.
   */
  due(
    now: Date,
    roles: readonly PlatformRole[],
    limit: number,
    staffUserId?: string,
  ): Promise<{ session: ActAsSession; reason: Exclude<ActAsEndReason, "staff"> }[]>;
};
