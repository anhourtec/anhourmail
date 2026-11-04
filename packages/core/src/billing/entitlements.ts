// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What an account is entitled to, and the rules for checkouts, add-on changes, plan switches and refunds (ADR-0029 §7,
 * §9), as pure functions. Services call them before any provider call.
 */
import {
  accountPoolBytes,
  BILLING,
  type Currency,
  MAX_EXTRA_MAILBOXES,
  MAX_STORAGE_BLOCKS,
  mailboxCeiling,
  type PaidPlanId,
  peopleCeiling,
  PLANS,
  type PlanId,
} from "@anhourmail/shared/plans";

import { DomainError } from "../errors";

import type { AccountBilling } from "./entity";
import { effectivePlan, isPaidState } from "./lifecycle";
import type { ProviderInvoice, SubscriptionChange } from "./ports";

const DAY_MS = 86_400_000;

export type BillingErrorCode =
  | "addon_in_use"
  | "checkout_pending"
  | "already_subscribed"
  | "not_subscribed"
  | "billing_unavailable"
  | "billing_restricted"
  | "address_ceiling"
  | "invite_code_invalid"
  | "refund_not_eligible"
  | "invalid_change"
  /** The processor declined the card for a charge made now (an add-on increase): HTTP 402. */
  | "card_declined"
  /** An increase was asked for without confirming the amount it charges now, or the amount moved since the preview. */
  | "confirmation_required";

/**
 * A billing rule refused the request. The HTTP layer maps the code (409 for conflicts like `addon_in_use`,
 * `checkout_pending`, `address_ceiling`, `already_subscribed`, `not_subscribed`, `refund_not_eligible`,
 * `confirmation_required`; 503 for `billing_unavailable`; 403 for `billing_restricted`; 404 for `invite_code_invalid`;
 * 400 for `invalid_change`; 402 for `card_declined`).
 */
export class BillingError extends DomainError {
  constructor(code: BillingErrorCode, message: string) {
    super(message, code);
  }
}

export type Entitlements = {
  plan: PlanId;
  storageBlocks: number;
  extraMailboxes: number;
  mailboxCeiling: number;
  peopleCeiling: number;
  poolBytes: number;
};

/**
 * Add-ons in force: the larger of the current quantity and the one paid for this period, so a decrease (which renews
 * lower) keeps the capacity already paid for until period end. None outside the paid states.
 */
export function entitledAddons(
  b: Pick<
    AccountBilling,
    "state" | "storageBlocks" | "extraMailboxes" | "periodPaidStorageBlocks" | "periodPaidExtraMailboxes"
  >,
): { storageBlocks: number; extraMailboxes: number } {
  if (!isPaidState(b.state)) return { storageBlocks: 0, extraMailboxes: 0 };
  return {
    storageBlocks: Math.min(MAX_STORAGE_BLOCKS, Math.max(b.storageBlocks, b.periodPaidStorageBlocks)),
    extraMailboxes: Math.min(MAX_EXTRA_MAILBOXES, Math.max(b.extraMailboxes, b.periodPaidExtraMailboxes)),
  };
}

export function entitlements(b: AccountBilling): Entitlements {
  const plan = effectivePlan(b);
  const { storageBlocks, extraMailboxes } = entitledAddons(b);
  return {
    plan,
    storageBlocks,
    extraMailboxes,
    mailboxCeiling: mailboxCeiling(plan, extraMailboxes),
    peopleCeiling: peopleCeiling(plan, extraMailboxes),
    poolBytes: accountPoolBytes(plan, storageBlocks),
  };
}

/** A whole number of add-ons within the public bounds, else what's wrong. */
export function addonQuantityProblem(kind: "storageBlocks" | "extraMailboxes", n: number): string | null {
  const max = kind === "storageBlocks" ? MAX_STORAGE_BLOCKS : MAX_EXTRA_MAILBOXES;
  if (!Number.isSafeInteger(n) || n < 0 || n > max) {
    return `${kind === "storageBlocks" ? "Storage blocks" : "Extra mailboxes"} must be a whole number from 0 to ${String(max)}.`;
  }
  return null;
}

/** The Supporter amount is whole currency units between the minimum and the maximum (ADR-0029 §2), else what's wrong. */
export function supporterAmountProblem(currency: Currency, amountMinor: number): string | null {
  const min = PLANS.supporter.price?.[currency] ?? 0;
  const max = BILLING.supporterMaximum[currency];
  if (!Number.isSafeInteger(amountMinor) || amountMinor % 100 !== 0) {
    return "Choose a whole amount (no cents).";
  }
  if (amountMinor < min || amountMinor > max) {
    return `Choose an amount from ${String(min / 100)} to ${String(max / 100)} ${currency} a year.`;
  }
  return null;
}

/** Why a checkout can't start now, or null: only from Free or lapsed, and not while one is pending. */
export function checkoutBlock(
  b: Pick<AccountBilling, "state" | "planSource" | "checkoutPendingUntil">,
  now: Date,
): "already_subscribed" | "checkout_pending" | null {
  // A comp may be replaced by a subscription at any time (§8); every other paid state already has a plan.
  if (isPaidState(b.state) && b.planSource !== "comp") return "already_subscribed";
  if (b.checkoutPendingUntil !== null && b.checkoutPendingUntil > now) return "checkout_pending";
  return null;
}

export type ChangeRequest = {
  plan?: PaidPlanId;
  supporterAmountMinor?: number;
  storageBlocks?: number;
  extraMailboxes?: number;
};

/**
 * How a plan or add-on change is billed. Increases are charged now, prorated (the console shows the preview and the
 * person confirms it: never auto-charged); decreases, Plus ↔ Supporter switches (features switch now, price at
 * renewal; maintainer default 2026-11-04) and Supporter amount changes renew at the new figure. One request is one
 * direction: an increase can't be mixed with a decrease or a plan or amount change, so a credit never offsets a
 * charge without the person seeing it.
 */
export function changeProration(
  current: Pick<AccountBilling, "storageBlocks" | "extraMailboxes" | "paidPlan" | "planAmountMinor">,
  req: ChangeRequest,
): SubscriptionChange["proration"] {
  const up =
    (req.storageBlocks ?? current.storageBlocks) > current.storageBlocks ||
    (req.extraMailboxes ?? current.extraMailboxes) > current.extraMailboxes;
  const down =
    (req.storageBlocks ?? current.storageBlocks) < current.storageBlocks ||
    (req.extraMailboxes ?? current.extraMailboxes) < current.extraMailboxes;
  const planSwitch = req.plan !== undefined && req.plan !== current.paidPlan;
  const amount = req.supporterAmountMinor !== undefined && req.supporterAmountMinor !== current.planAmountMinor;
  if (!up && !down && !planSwitch && !amount) throw new BillingError("invalid_change", "Nothing to change.");
  if (up && (down || planSwitch || amount)) {
    throw new BillingError("invalid_change", "Add capacity on its own, then make other changes separately.");
  }
  return up ? "charge_now" : "none";
}

/** What the account uses now, for refusing a decrease that would strand anything at renewal. */
export type AddonUsage = { mailboxes: number; assignedQuotaBytes: number };

/**
 * A decrease is refused while the account would be over the new figure at renewal (`409 addon_in_use`): delete a
 * mailbox or lower mailbox storage first. Only a lapse can strand anything (and then it is held, not deleted).
 */
export function assertDecreaseFits(
  plan: PaidPlanId,
  next: { storageBlocks: number; extraMailboxes: number },
  usage: AddonUsage,
): void {
  if (usage.mailboxes > mailboxCeiling(plan, next.extraMailboxes)) {
    throw new BillingError("addon_in_use", "Delete a mailbox first: the account would have more than the plan allows.");
  }
  if (usage.assignedQuotaBytes > accountPoolBytes(plan, next.storageBlocks)) {
    throw new BillingError("addon_in_use", "Lower mailbox storage first: the account assigns more than that pool.");
  }
}

export type RefundRefusal = "no_invoice" | "not_paid" | "not_plan_invoice" | "outside_window" | "already_refunded";

/**
 * Self-service refund (ADR-0029 §9): the latest invoice is paid, is the first or a renewal invoice (not an add-on
 * proration), was paid at most `BILLING.refundWindowDays` days ago (14 × 24 h, inclusive) and nothing of it is refunded
 * yet. Anything else is refunded only by staff.
 */
export function refundEligibility(
  invoice: ProviderInvoice | null,
  now: Date,
): { eligible: true } | { eligible: false; reason: RefundRefusal } {
  if (!invoice) return { eligible: false, reason: "no_invoice" };
  if (invoice.status !== "paid" || invoice.paidAt === null) return { eligible: false, reason: "not_paid" };
  if (invoice.billingReason === "other") return { eligible: false, reason: "not_plan_invoice" };
  if (invoice.refundedMinor > 0) return { eligible: false, reason: "already_refunded" };
  if (now.getTime() - invoice.paidAt.getTime() > BILLING.refundWindowDays * DAY_MS) {
    return { eligible: false, reason: "outside_window" };
  }
  return { eligible: true };
}

/** Mailboxes + aliases + masked aliases one account may hold: the configured ceiling or the staff override. */
export function addressCeiling(b: Pick<AccountBilling, "addressCeilingOverride"> | null, configured: number): number {
  return b?.addressCeilingOverride ?? configured;
}
