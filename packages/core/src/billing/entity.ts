// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing domain types (ADR-0029). Our database never holds card data, addresses, tax ids or webhook payloads: the
 * provider holds them, and we keep only the state we derive from it. Names say `provider`, never a vendor (ADR-0008).
 */
import type { Currency, PaidPlanId } from "@anhourmail/shared/plans";

export const BILLING_STATES = ["free", "active", "past_due", "restricted", "lapsed"] as const;
/**
 * An account's billing state (ADR-0029 §5), separate from staff suspension (`customer_account.status`) and from trust.
 * - `free`: never paid, or no live subscription and no holds.
 * - `active`: a paying subscription, a comp code or a staff grant.
 * - `past_due`: a renewal failed and the provider is retrying; nothing changes for the customer.
 * - `restricted`: retries ran out, the subscription is paused, or a dispute is open: sending stops, nothing else.
 * - `lapsed`: the paid plan ended and some resources don't fit Free: they are held, never deleted.
 */
export type BillingState = (typeof BILLING_STATES)[number];

export const PLAN_SOURCES = ["none", "stripe", "comp", "staff"] as const;
/** Where a paid plan comes from. `stripe` is the provider's name for the column value only (ADR-0029 §11). */
export type PlanSource = (typeof PLAN_SOURCES)[number];

export const INVOICE_STATUSES = ["paid", "open", "uncollectible", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** One row per account (Postgres `account_billing`). Quantities are whole numbers ≥ 0. */
export type AccountBilling = {
  accountId: string;
  state: BillingState;
  stateSince: Date;
  planSource: PlanSource;
  /** The paid plan in force (null on Free and after a lapse). */
  paidPlan: PaidPlanId | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Fixed at the first checkout (the provider locks a customer's currency). */
  currency: Currency | null;
  /** Plus price or the Supporter amount, per year, tax-exclusive, minor units. */
  planAmountMinor: number | null;
  storageBlocks: number;
  extraMailboxes: number;
  /** Quantities on the last paid first or renewal invoice: capacity paid for stays until period end (§7). */
  periodPaidStorageBlocks: number;
  periodPaidExtraMailboxes: number;
  currentPeriodEnd: Date | null;
  /** Set while a cancellation at period end is scheduled. */
  cancelAt: Date | null;
  restrictedAt: Date | null;
  disputedAt: Date | null;
  lapsedAt: Date | null;
  /** End of a comp code's free period (`planSource` `comp`). */
  compUntil: Date | null;
  lastInvoiceId: string | null;
  lastInvoiceStatus: InvoiceStatus | null;
  /** A checkout was started: no second one until then (`409 checkout_pending`). */
  checkoutPendingUntil: Date | null;
  /** Staff override of the account address ceiling (ADR-0029 §7); null = the configured ceiling. */
  addressCeilingOverride: number | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
};

export const BILLING_EVENT_STATUSES = ["queued", "processed", "orphan", "dismissed"] as const;
export type BillingEventStatus = (typeof BILLING_EVENT_STATUSES)[number];

/**
 * A provider event we received (Postgres `billing_event`). Events are triggers, not data: no payload is stored (it
 * carries names, emails and addresses); the sync fetches the truth from the provider.
 */
export type BillingEvent = {
  id: string;
  providerEventId: string;
  type: string;
  /** Null for an orphan (no account has that provider customer). */
  accountId: string | null;
  objectId: string;
  providerCreatedAt: Date;
  status: BillingEventStatus;
  /** An error name when processing failed (never a message with personal data). */
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export const HOLD_SUBJECTS = ["mailbox", "domain", "alias"] as const;
export type HoldSubject = (typeof HOLD_SUBJECTS)[number];

/** Something a lapsed account keeps but can't use fully on Free (Postgres `plan_hold`; ADR-0029 §6). */
export type PlanHold = {
  id: string;
  accountId: string;
  subjectType: HoldSubject;
  subjectId: string;
  heldAt: Date;
  /** Mailboxes only: receiving stops after this; reading, sign-in and export never do. */
  receiveUntil: Date | null;
};

/** A hold to write (the repository assigns ids). */
export type PlanHoldInput = Pick<PlanHold, "subjectType" | "subjectId" | "receiveUntil">;

/**
 * A staff-made invite code (Postgres `invite_code`; ADR-0029 §8). Only the sha256 of the code is stored; the code is
 * shown once. Platform-owned, not account-scoped.
 */
export type InviteCode = {
  id: string;
  codeHash: string;
  label: string;
  grantsSignup: boolean;
  compPlan: PaidPlanId | null;
  compDays: number | null;
  /** Bound to one console email (lower-cased), or anyone. */
  email: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedBy: string | null;
  redeemedAccountId: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
};

export type InviteCodeStatus = "active" | "redeemed" | "revoked" | "expired";
