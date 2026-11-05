// SPDX-License-Identifier: AGPL-3.0-only
import type { PaidPlanId } from "@anhourmail/shared/plans";

import type {
  AccountBilling,
  BillingDispute,
  BillingEvent,
  BillingEventStatus,
  BillingState,
  CatalogueStatus,
  HoldSubject,
  InviteCode,
  PlanHold,
  PlanHoldInput,
} from "./entity";

/**
 * Account billing rows, received provider events and plan holds (ADR-0029 §11). Every account-scoped read and write
 * takes the account id, so another account's rows are simply not found. The only lookups not scoped to an account are
 * the webhook's (`byCustomerId`, `recordEvent`) and staff lists, which the services gate by platform permission.
 */
export type BillingRepository = {
  /** The account's billing row, or null when it has none yet (`defaultBilling` gives its meaning). */
  get(accountId: string): Promise<AccountBilling | null>;
  /** Inserts or replaces the account's row (the sync writes the whole derived row under the account lock). */
  save(row: AccountBilling): Promise<void>;
  /** The account a provider customer belongs to (webhook ingestion). */
  byCustomerId(customerId: string): Promise<AccountBilling | null>;
  /** Accounts in one state, oldest state change first (staff lists, `billing.timers`). */
  listByState(state: BillingState, limit: number): Promise<AccountBilling[]>;
  /** Accounts with a provider customer whose last sync is older than `before` (or never), oldest first. */
  dueForSync(before: Date, limit: number): Promise<string[]>;
  /** Accounts on a comp (`plan_source` comp) whose free period ended at or before `at`, earliest first (`billing.timers`). */
  compsEnded(at: Date, limit: number): Promise<string[]>;

  /**
   * Records a received event once and returns its id: null when that provider event id was already recorded (a
   * duplicate delivery). `accountId` null records an orphan.
   */
  recordEvent(input: {
    providerEventId: string;
    type: string;
    accountId: string | null;
    objectId: string;
    providerCreatedAt: Date;
    receivedAt: Date;
  }): Promise<string | null>;
  /** The account's queued events, oldest provider time first. */
  pendingEvents(accountId: string): Promise<BillingEvent[]>;
  /** Marks queued events of the account processed (or failed with an error name). Returns how many changed. */
  markEventsProcessed(accountId: string, ids: readonly string[], at: Date, error?: string): Promise<number>;
  /** One event by our id, whatever its account (the worker resolving an orphan), or null. */
  getEvent(id: string): Promise<BillingEvent | null>;
  /** Events in one status across accounts, newest first (staff: orphans). */
  listEvents(status: BillingEventStatus, limit: number): Promise<BillingEvent[]>;
  /**
   * Attaches an orphan to the account it was resolved to and queues it for that account's sync (dispute events carry
   * no customer: the worker resolves them through `BillingProvider.getDispute`). False when it isn't an orphan (any
   * more). Unresolved orphans are never dropped: they stay for the next attempt and for staff.
   */
  adoptOrphan(id: string, accountId: string): Promise<boolean>;
  /** Staff dismiss an orphan. False when it isn't an orphan (any more). */
  dismissOrphan(id: string, at: Date): Promise<boolean>;
  /** Deletes processed and dismissed events received before `before`; orphans are kept. Returns how many. */
  pruneEvents(before: Date): Promise<number>;

  /** The account's tracked disputes, oldest first. */
  disputes(accountId: string): Promise<BillingDispute[]>;
  /**
   * Inserts or updates these disputes of the account (by provider dispute id). A dispute id already tracked for another
   * account is left alone (never moved between accounts).
   */
  saveDisputes(accountId: string, rows: readonly BillingDispute[]): Promise<void>;

  /** The account's plan holds, mailboxes first, then domains, then aliases, oldest first. */
  holds(accountId: string): Promise<PlanHold[]>;
  /** Which of these subjects of the account are held. */
  heldIds(accountId: string, subjectType: HoldSubject, ids: readonly string[]): Promise<string[]>;
  /** Replaces every hold of the account with these (holds applied or the Owner's swap). */
  replaceHolds(accountId: string, holds: readonly PlanHoldInput[], at: Date): Promise<void>;
  /** Deletes every hold of the account (upgrade). Returns how many. */
  clearHolds(accountId: string): Promise<number>;

  /** The last catalogue check (platform-wide, one row), or null before the first one. */
  catalogue(): Promise<CatalogueStatus | null>;
  /** Replaces the last catalogue check. */
  saveCatalogue(status: CatalogueStatus): Promise<void>;
};

/**
 * Staff-made invite codes (ADR-0029 §8). Platform-owned: reads by id are for staff, redemption reads by hash only.
 */
export type InviteCodeRepository = {
  create(input: {
    codeHash: string;
    label: string;
    grantsSignup: boolean;
    compPlan: PaidPlanId | null;
    compDays: number | null;
    email: string | null;
    createdBy: string | null;
    expiresAt: Date;
    at: Date;
  }): Promise<InviteCode>;
  get(id: string): Promise<InviteCode | null>;
  /** Newest first. */
  list(limit: number): Promise<InviteCode[]>;
  /** A code that can still be redeemed now (not redeemed, not revoked, not expired) and fits the email, or null. */
  findRedeemable(codeHash: string, email: string, now: Date): Promise<InviteCode | null>;
  /**
   * Claims a code atomically: of any number of concurrent redeemers exactly one gets the code back, the rest null.
   * Null too when it is redeemed, revoked, expired, unknown or bound to another email (one answer: no oracle).
   */
  claim(input: {
    codeHash: string;
    email: string;
    /** Null claims it as pending for a sign-up whose person doesn't exist yet (`attachClaim` / `releaseClaim`). */
    userId: string | null;
    accountId: string | null;
    now: Date;
  }): Promise<InviteCode | null>;
  /**
   * Attaches the person (and account) a pending claim was for, once the sign-up created them. False when the code isn't
   * pending (never claimed, already attached, or another redemption's).
   */
  attachClaim(input: { id: string; userId: string; accountId: string | null }): Promise<boolean>;
  /**
   * Gives a pending claim back (the sign-up it was for didn't create an account): the code is redeemable again until it
   * expires. False when it isn't pending.
   */
  releaseClaim(id: string): Promise<boolean>;
  /** Revokes an unused code. False when it was already redeemed or revoked, or doesn't exist. */
  revoke(id: string, by: string, at: Date): Promise<boolean>;
};
