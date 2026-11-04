// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The billing lifecycle as pure functions (ADR-0029 §5). The sync fetches the provider's subscription, then
 * `deriveBilling` computes the account's next billing row and the list of changes to audit and act on. Nothing here
 * does I/O, reads the clock or deletes anything: non-payment never deletes mail (rule 26).
 */
import { BILLING, isPaidPlan, type PaidPlanId, type PlanId } from "@anhourmail/shared/plans";

import {
  type AccountBilling,
  type BillingDispute,
  type BillingDisputeStatus,
  type BillingEvent,
  type BillingState,
  isRestrictingDispute,
  type PlanHold,
  type PlanSource,
} from "./entity";
import { type DisputeOutcome, isLiveSubStatus, type ProviderSubscription } from "./ports";

const DAY_MS = 86_400_000;

/** States in which a paid plan is in force (its limits apply). */
export const PAID_STATES: readonly BillingState[] = ["active", "past_due", "restricted"];

export const isPaidState = (s: BillingState): boolean => PAID_STATES.includes(s);

/**
 * The billing row of an account that has none yet (created before billing, or by the seed): Free, or a staff grant
 * when the account is already on a paid plan — the same rule as the backfill migration.
 */
export function defaultBilling(accountId: string, plan: PlanId, at: Date): AccountBilling {
  const paid = isPaidPlan(plan);
  return {
    accountId,
    state: paid ? "active" : "free",
    stateSince: at,
    planSource: paid ? "staff" : "none",
    paidPlan: paid ? plan : null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    currency: null,
    planAmountMinor: null,
    storageBlocks: 0,
    extraMailboxes: 0,
    periodPaidStorageBlocks: 0,
    periodPaidExtraMailboxes: 0,
    periodPaidFor: null,
    currentPeriodEnd: null,
    cancelAt: null,
    restrictedAt: null,
    disputedAt: null,
    lapsedAt: null,
    compUntil: null,
    lastInvoiceId: null,
    lastInvoiceStatus: null,
    checkoutPendingUntil: null,
    selfServiceRefundAt: null,
    addressCeilingOverride: null,
    lastSyncedAt: null,
    updatedAt: at,
  };
}

/** The plan whose limits apply (written to `customer_account.plan`, which the rest of the code reads). */
export function effectivePlan(b: Pick<AccountBilling, "state" | "paidPlan">): PlanId {
  return isPaidState(b.state) && b.paidPlan !== null ? b.paidPlan : "free";
}

export type StateReason =
  | "checkout_paid"
  | "resubscribed"
  | "payment_failed"
  | "payment_recovered"
  | "retries_exhausted"
  | "paused"
  | "dispute_opened"
  | "dispute_closed"
  | "subscription_ended"
  | "comp_started"
  | "comp_ended"
  | "staff_grant"
  | "holds_resolved";

/** What changed in one derivation; the sync audits each and enqueues the mail-server work it implies. */
export type BillingChange =
  | { kind: "state_changed"; from: BillingState; to: BillingState; reason: StateReason }
  | { kind: "plan_changed"; from: PlanId; to: PlanId; source: PlanSource }
  | {
      kind: "addons_changed";
      storageBlocks: { from: number; to: number };
      extraMailboxes: { from: number; to: number };
    }
  | { kind: "supporter_amount_changed"; from: number; to: number }
  | { kind: "payment_succeeded"; invoiceId: string; amountMinor: number }
  | { kind: "payment_failed"; invoiceId: string; amountMinor: number | null }
  | { kind: "cancel_scheduled"; at: Date }
  | { kind: "cancel_undone" }
  | { kind: "dispute_opened" }
  /** A dispute-closed event with its outcome (`unknown` when the provider couldn't tell us: the restriction stays). */
  | { kind: "dispute_closed"; disputeId: string; outcome: DisputeOutcome | "unknown" }
  | { kind: "refunded"; objectId: string; amountMinor: number | null }
  /** The account entered `lapsed`: the sync writes the plan holds (`computeHolds`). */
  | { kind: "holds_needed" }
  /** The account left `lapsed` for a paid state: the sync deletes every hold. */
  | { kind: "holds_lifted" };

/** The facts of a stored event the sync reads (the subscription doesn't carry disputes or dashboard refunds). */
export type PendingBillingEvent = Pick<BillingEvent, "id" | "type" | "objectId" | "providerCreatedAt"> & {
  /**
   * For `charge.dispute.closed`: the dispute's outcome, read fresh by the sync (`BillingProvider.getDispute`; events
   * store no payload). Missing or null = unknown, which never lifts a restriction.
   */
  disputeOutcome?: DisputeOutcome | null;
};

export type DeriveContext = {
  now: Date;
  /**
   * How many plan holds the account has, or would have if it dropped to Free now (`computeHolds(...).holds.length`).
   * A paid plan ending with nothing to hold goes straight to `free`; a lapsed account with none left becomes `free`.
   */
  holdCount: number;
  /** The account's tracked disputes before this sync (`BillingRepository.disputes`). */
  disputes?: readonly BillingDispute[];
  /**
   * Disputes read fresh from the provider by this sync (`getDispute`): the events' disputes and every tracked one still
   * open. A dispute missing here keeps what the event (`disputeOutcome`) or the tracked row says.
   */
  disputeStatuses?: ReadonlyMap<string, DisputeOutcome>;
};

export type Derivation = {
  next: AccountBilling;
  changes: BillingChange[];
  processedEventIds: string[];
  /** Tracked disputes that are new or changed by this derivation (the sync writes them). */
  disputes: BillingDispute[];
};

const byCreated = (a: PendingBillingEvent, b: PendingBillingEvent) =>
  a.providerCreatedAt.getTime() - b.providerCreatedAt.getTime() || a.id.localeCompare(b.id);

const CLOSED: readonly BillingDisputeStatus[] = ["won", "lost", "warning_closed"];
const liftsDispute = (s: BillingDisputeStatus) => s === "won" || s === "warning_closed";

type DisputeTracking = {
  /** New or changed rows. */
  changed: BillingDispute[];
  /** Every tracked dispute after this batch. */
  all: BillingDispute[];
  /** One per dispute that closed in this batch (an event, or a fresh read of one still open). */
  closed: { disputeId: string; outcome: DisputeOutcome | "unknown" }[];
  /** A dispute was won (or an inquiry closed without a chargeback) in this batch. */
  lifted: boolean;
};

/**
 * Tracks disputes one by one (ADR-0029 §5, residual fixed 2026-11-04): a created event adds the dispute as open (or as
 * the provider reports it now); a closed event, or a fresh read of a tracked open dispute, records its outcome; a close
 * whose outcome couldn't be read keeps it open, so it still restricts. A created event never reopens a closed dispute
 * (it can arrive after the close), and a staff clear is never undone by the provider's view. Only `open` and `lost`
 * restrict, so one dispute won never clears another still open or lost.
 */
function trackDisputes(
  accountId: string,
  tracked: readonly BillingDispute[],
  events: readonly PendingBillingEvent[],
  fresh: ReadonlyMap<string, DisputeOutcome>,
  now: Date,
): DisputeTracking {
  const rows = new Map(tracked.map((d) => [d.disputeId, { ...d }] as const));
  const before = new Map(tracked.map((d) => [d.disputeId, d.status] as const));
  const closedEvents = new Map<string, DisputeOutcome | "unknown">();
  const touched = new Set<string>();
  const set = (disputeId: string, status: BillingDisputeStatus) => {
    const cur = rows.get(disputeId);
    if (cur?.status === "cleared") return;
    if (!cur) {
      rows.set(disputeId, {
        accountId,
        disputeId,
        status,
        openedAt: now,
        closedAt: CLOSED.includes(status) ? now : null,
        updatedAt: now,
      });
      touched.add(disputeId);
      return;
    }
    if (cur.status === status) return;
    Object.assign(cur, { status, closedAt: CLOSED.includes(status) ? now : null, updatedAt: now });
    touched.add(disputeId);
  };
  for (const e of events) {
    const read = fresh.get(e.objectId) ?? e.disputeOutcome ?? null;
    if (e.type === "charge.dispute.created") {
      if (!rows.has(e.objectId)) set(e.objectId, read ?? "open");
      else if (fresh.has(e.objectId) && read !== null) set(e.objectId, read);
    } else if (e.type === "charge.dispute.closed") {
      closedEvents.set(e.objectId, read ?? "unknown");
      set(e.objectId, read ?? "open");
    }
  }
  for (const [id, status] of fresh) {
    if (rows.get(id)?.status === "open") set(id, status);
  }
  const all = [...rows.values()];
  const closed: DisputeTracking["closed"] = [];
  for (const d of all) {
    const event = closedEvents.get(d.disputeId);
    if (event !== undefined) closed.push({ disputeId: d.disputeId, outcome: event });
    else if (touched.has(d.disputeId) && before.get(d.disputeId) === "open" && CLOSED.includes(d.status)) {
      closed.push({ disputeId: d.disputeId, outcome: d.status as DisputeOutcome });
    }
  }
  const lifted = all.some(
    (d) => touched.has(d.disputeId) && liftsDispute(d.status) && !liftsDispute(before.get(d.disputeId) ?? "open"),
  );
  return { changed: all.filter((d) => touched.has(d.disputeId)), all, closed, lifted };
}

type Target = { state: BillingState; source: PlanSource; plan: PaidPlanId | null };

function baseState(sub: ProviderSubscription): BillingState {
  switch (sub.status) {
    case "past_due":
      return "past_due";
    case "unpaid":
    case "paused":
      return "restricted";
    default:
      return "active"; // active, trialing (never configured)
  }
}

function reasonFor(
  previous: AccountBilling,
  target: Target,
  sub: ProviderSubscription | null,
  disputed: boolean,
): StateReason {
  const from = previous.state;
  const wasDisputed = previous.disputedAt !== null;
  switch (target.state) {
    case "active":
      if (from === "free" || from === "lapsed") {
        if (target.source === "comp") return "comp_started";
        if (target.source === "staff") return "staff_grant";
        return from === "lapsed" ? "resubscribed" : "checkout_paid";
      }
      return from === "restricted" && wasDisputed && !disputed ? "dispute_closed" : "payment_recovered";
    case "past_due":
      return from === "restricted" && wasDisputed && !disputed ? "dispute_closed" : "payment_failed";
    case "restricted":
      if (disputed && !wasDisputed) return "dispute_opened";
      return sub?.status === "paused" ? "paused" : "retries_exhausted";
    case "lapsed":
    case "free":
      if (from === "lapsed") return "holds_resolved";
      return previous.planSource === "comp" ? "comp_ended" : "subscription_ended";
  }
}

const newlyPaid = (previous: AccountBilling, sub: ProviderSubscription): boolean => {
  const inv = sub.latestInvoice;
  return inv?.status === "paid" && (inv.id !== previous.lastInvoiceId || previous.lastInvoiceStatus !== "paid");
};

/**
 * Computes the account's next billing row from the previous one, the provider's live subscription (null = none), the
 * pending events (oldest first is not required: they are sorted here) and the context. Deterministic and total: any
 * provider status maps to a state. Reordered or duplicated events only cause a redundant derivation.
 *
 * Decisions beyond the ADR text: a dispute is sticky — once open it stays until a dispute closes as won (or an inquiry
 * closes without a chargeback) or staff clear it, even when the latest invoice moves on (the provider only reports
 * disputes on the latest one). A lost dispute, or a close whose outcome is unknown, keeps the account restricted until
 * staff clear it or the subscription ends (then it lapses like any other). An `incomplete` subscription (3-D Secure
 * abandoned) counts as none, so it grants nothing.
 */
export function deriveBilling(
  previous: AccountBilling,
  sub: ProviderSubscription | null,
  events: readonly PendingBillingEvent[],
  ctx: DeriveContext,
): Derivation {
  const { now } = ctx;
  const sorted = [...events].sort(byCreated);
  const live = sub && isLiveSubStatus(sub.status) && sub.status !== "incomplete" ? sub : null;

  const tracking = trackDisputes(previous.accountId, ctx.disputes ?? [], sorted, ctx.disputeStatuses ?? new Map(), now);
  // Restricted while the provider reports a dispute on the latest payment, while any tracked dispute is open or lost,
  // or, sticky, while one was before and none was won in this batch (a dispute whose event is still unresolved).
  const disputed =
    (live?.disputed ?? false) ||
    (live?.disputeLost ?? false) ||
    tracking.all.some((d) => isRestrictingDispute(d.status)) ||
    (previous.disputedAt !== null && !tracking.lifted);

  let target: Target;
  if (live) {
    target = { state: disputed ? "restricted" : baseState(live), source: "stripe", plan: live.plan };
  } else if (
    previous.planSource === "comp" &&
    previous.paidPlan !== null &&
    previous.compUntil !== null &&
    previous.compUntil > now
  ) {
    target = { state: "active", source: "comp", plan: previous.paidPlan };
  } else if (previous.planSource === "staff" && previous.paidPlan !== null) {
    target = { state: "active", source: "staff", plan: previous.paidPlan };
  } else {
    const lapses = previous.state !== "free" && ctx.holdCount > 0;
    target = { state: lapses ? "lapsed" : "free", source: "none", plan: null };
  }

  const stateChanged = target.state !== previous.state;
  const next: AccountBilling = {
    ...previous,
    state: target.state,
    stateSince: stateChanged ? now : previous.stateSince,
    planSource: target.source,
    paidPlan: target.plan,
    restrictedAt:
      target.state === "restricted" ? (previous.state === "restricted" ? (previous.restrictedAt ?? now) : now) : null,
    disputedAt: disputed ? (previous.disputedAt ?? now) : null,
    lastSyncedAt: now,
    updatedAt: now,
  };

  if (live) {
    const paidNow = newlyPaid(previous, live);
    // A newly paid first or renewal invoice sets the capacity paid for its period from what the invoice billed (never
    // from the live subscription, which may have been raised since without a charge), tagged with that period.
    const inv = live.latestInvoice;
    const planInvoice = paidNow && inv !== null && inv.billingReason !== "other";
    Object.assign(next, {
      providerSubscriptionId: live.subscriptionId,
      currency: live.currency,
      planAmountMinor: live.planAmountMinor,
      storageBlocks: live.storageBlocks,
      extraMailboxes: live.extraMailboxes,
      periodPaidStorageBlocks: planInvoice
        ? (inv.storageBlocks ?? live.storageBlocks)
        : previous.periodPaidStorageBlocks,
      periodPaidExtraMailboxes: planInvoice
        ? (inv.extraMailboxes ?? live.extraMailboxes)
        : previous.periodPaidExtraMailboxes,
      periodPaidFor: planInvoice ? (inv.periodEnd ?? live.currentPeriodEnd) : previous.periodPaidFor,
      currentPeriodEnd: live.currentPeriodEnd,
      cancelAt: live.cancelAt,
      compUntil: null,
      lastInvoiceId: live.latestInvoice?.id ?? previous.lastInvoiceId,
      lastInvoiceStatus: live.latestInvoice?.status ?? previous.lastInvoiceStatus,
      checkoutPendingUntil: null,
      lapsedAt: null,
    } satisfies Partial<AccountBilling>);
  } else {
    // Comp, staff grant, Free or lapsed: no subscription, no add-ons (a comp grants the plan, not extras).
    Object.assign(next, {
      providerSubscriptionId: null,
      planAmountMinor: null,
      storageBlocks: 0,
      extraMailboxes: 0,
      periodPaidStorageBlocks: 0,
      periodPaidExtraMailboxes: 0,
      periodPaidFor: null,
      currentPeriodEnd: target.source === "comp" ? previous.compUntil : null,
      cancelAt: null,
      compUntil: target.source === "comp" ? previous.compUntil : null,
      lapsedAt: target.state === "lapsed" ? (previous.state === "lapsed" ? (previous.lapsedAt ?? now) : now) : null,
    } satisfies Partial<AccountBilling>);
  }

  const changes: BillingChange[] = [];
  if (stateChanged) {
    changes.push({
      kind: "state_changed",
      from: previous.state,
      to: target.state,
      reason: reasonFor(previous, target, live, disputed),
    });
  }
  const planFrom = effectivePlan(previous);
  const planTo = effectivePlan(next);
  if (planFrom !== planTo) changes.push({ kind: "plan_changed", from: planFrom, to: planTo, source: next.planSource });
  if (previous.storageBlocks !== next.storageBlocks || previous.extraMailboxes !== next.extraMailboxes) {
    changes.push({
      kind: "addons_changed",
      storageBlocks: { from: previous.storageBlocks, to: next.storageBlocks },
      extraMailboxes: { from: previous.extraMailboxes, to: next.extraMailboxes },
    });
  }
  if (
    previous.paidPlan === "supporter" &&
    next.paidPlan === "supporter" &&
    previous.planAmountMinor !== null &&
    next.planAmountMinor !== null &&
    previous.planAmountMinor !== next.planAmountMinor
  ) {
    changes.push({ kind: "supporter_amount_changed", from: previous.planAmountMinor, to: next.planAmountMinor });
  }
  if (live?.latestInvoice && newlyPaid(previous, live)) {
    changes.push({
      kind: "payment_succeeded",
      invoiceId: live.latestInvoice.id,
      amountMinor: live.latestInvoice.amountMinor,
    });
  }
  for (const e of sorted) {
    if (e.type === "invoice.payment_failed") {
      const inv = live?.latestInvoice;
      changes.push({
        kind: "payment_failed",
        invoiceId: e.objectId,
        amountMinor: inv?.id === e.objectId ? inv.amountMinor : null,
      });
    } else if (e.type === "charge.refunded") {
      changes.push({ kind: "refunded", objectId: e.objectId, amountMinor: live?.latestInvoice?.refundedMinor ?? null });
    }
  }
  if (next.cancelAt !== null && previous.cancelAt === null)
    changes.push({ kind: "cancel_scheduled", at: next.cancelAt });
  if (live && next.cancelAt === null && previous.cancelAt !== null) changes.push({ kind: "cancel_undone" });
  if (disputed && previous.disputedAt === null) changes.push({ kind: "dispute_opened" });
  for (const c of tracking.closed) changes.push({ kind: "dispute_closed", ...c });
  if (next.state === "lapsed" && previous.state !== "lapsed") changes.push({ kind: "holds_needed" });
  if (previous.state === "lapsed" && isPaidState(next.state)) changes.push({ kind: "holds_lifted" });

  return { next, changes, processedEventIds: sorted.map((e) => e.id), disputes: tracking.changed };
}

/**
 * `billing.timers`: a `restricted` account whose payment never came within `BILLING.restrictedDays` has its
 * subscription cancelled now (it then lapses on the next sync). A dispute-only restriction is excluded: disputes take
 * longer than that to resolve, and staff handle them.
 */
export function restrictedTimedOut(
  b: Pick<AccountBilling, "state" | "restrictedAt" | "disputedAt">,
  now: Date,
): boolean {
  return (
    b.state === "restricted" &&
    b.disputedAt === null &&
    b.restrictedAt !== null &&
    now.getTime() - b.restrictedAt.getTime() >= BILLING.restrictedDays * DAY_MS
  );
}

/** `billing.timers`: a comp has ended (the next sync lapses the account unless it subscribed meanwhile). */
export function compEnded(b: Pick<AccountBilling, "planSource" | "compUntil">, now: Date): boolean {
  return b.planSource === "comp" && b.compUntil !== null && b.compUntil <= now;
}

/** What billing allows a mailbox (the most restrictive source wins in `mailbox.ensure`; staff suspension is separate). */
export type BillingMailboxAccess = "active" | "send_blocked" | "receive_blocked";

/**
 * A mailbox's access from billing alone: a `restricted` account can't send; a held mailbox can't send and, once its
 * receive window has passed, can't receive either. Reading, sign-in and export are never taken away by billing.
 */
export function billingMailboxAccess(
  state: BillingState,
  hold: Pick<PlanHold, "receiveUntil"> | null,
  now: Date,
): BillingMailboxAccess {
  if (hold) return hold.receiveUntil !== null && now >= hold.receiveUntil ? "receive_blocked" : "send_blocked";
  return state === "restricted" ? "send_blocked" : "active";
}
