// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { AccountBilling, BillingState } from "./entity";
import {
  billingMailboxAccess,
  compEnded,
  defaultBilling,
  deriveBilling,
  effectivePlan,
  isPaidState,
  type PendingBillingEvent,
  restrictedTimedOut,
} from "./lifecycle";
import type { DisputeOutcome, ProviderSubscription, ProviderSubStatus } from "./ports";

const T0 = new Date("2026-11-01T00:00:00Z");
const NOW = new Date("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

const free = (over: Partial<AccountBilling> = {}): AccountBilling => ({
  ...defaultBilling(ACCOUNT, "free", T0),
  providerCustomerId: "cus_1",
  ...over,
});

const paid = (over: Partial<AccountBilling> = {}): AccountBilling =>
  free({
    state: "active",
    planSource: "stripe",
    paidPlan: "plus",
    providerSubscriptionId: "sub_1",
    currency: "USD",
    planAmountMinor: 900,
    currentPeriodEnd: new Date("2027-11-01T00:00:00Z"),
    lastInvoiceId: "in_1",
    lastInvoiceStatus: "paid",
    ...over,
  });

const sub = (over: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  subscriptionId: "sub_1",
  customerId: "cus_1",
  status: "active",
  plan: "plus",
  currency: "USD",
  planAmountMinor: 900,
  storageBlocks: 0,
  extraMailboxes: 0,
  currentPeriodStart: T0,
  currentPeriodEnd: new Date("2027-11-01T00:00:00Z"),
  cancelAt: null,
  latestInvoice: {
    id: "in_1",
    status: "paid",
    amountMinor: 900,
    paidAt: T0,
    billingReason: "subscription_create",
    refundedMinor: 0,
    // Unreadable lines by default: the sync falls back to the subscription's quantities and period.
    storageBlocks: null,
    extraMailboxes: null,
    periodEnd: null,
  },
  disputed: false,
  disputeLost: false,
  ...over,
});

const ev = (type: string, at: Date = NOW, id = `evt_${type}`): PendingBillingEvent => ({
  id,
  type,
  objectId: `obj_${type}`,
  providerCreatedAt: at,
});

const ctx = (holdCount = 0) => ({ now: NOW, holdCount });

describe("defaultBilling and effectivePlan", () => {
  it("an account without a row is Free, or a staff grant on a paid plan (the backfill rule)", () => {
    expect(defaultBilling(ACCOUNT, "free", T0)).toMatchObject({ state: "free", planSource: "none", paidPlan: null });
    expect(defaultBilling(ACCOUNT, "supporter", T0)).toMatchObject({
      state: "active",
      planSource: "staff",
      paidPlan: "supporter",
    });
  });

  it("paid limits apply in active, past_due and restricted only", () => {
    const states: BillingState[] = ["free", "active", "past_due", "restricted", "lapsed"];
    expect(states.map((state) => effectivePlan({ state, paidPlan: "plus" }))).toEqual([
      "free",
      "plus",
      "plus",
      "plus",
      "free",
    ]);
    expect(effectivePlan({ state: "active", paidPlan: null })).toBe("free");
    expect(states.filter(isPaidState)).toEqual(["active", "past_due", "restricted"]);
  });
});

describe("deriveBilling: every provider status (ADR-0029 §5)", () => {
  const table: [ProviderSubStatus, BillingState][] = [
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "past_due"],
    ["unpaid", "restricted"],
    ["paused", "restricted"],
  ];
  it.each(table)("a %s subscription on a paid account → %s", (status, state) => {
    const { next } = deriveBilling(paid(), sub({ status }), [], ctx());
    expect(next.state).toBe(state);
    expect(next.planSource).toBe("stripe");
    expect(effectivePlan(next)).toBe("plus");
  });

  it.each(["canceled", "incomplete_expired", "incomplete"] as const)(
    "a %s subscription counts as none: a Free account stays Free and nothing changes",
    (status) => {
      const { next, changes } = deriveBilling(free(), sub({ status }), [], ctx());
      expect(next.state).toBe("free");
      expect(next.providerSubscriptionId).toBeNull();
      expect(changes).toEqual([]);
      expect(next.lastSyncedAt).toEqual(NOW);
    },
  );
});

describe("deriveBilling: transitions", () => {
  it("free → active on a paid checkout, with plan, quantities and the period paid for", () => {
    const { next, changes } = deriveBilling(
      free({ checkoutPendingUntil: new Date(NOW.getTime() + 3_600_000) }),
      sub({
        storageBlocks: 2,
        extraMailboxes: 3,
        latestInvoice: { ...sub().latestInvoice!, id: "in_new" },
      }),
      [ev("checkout.session.completed")],
      ctx(),
    );
    expect(next).toMatchObject({
      state: "active",
      stateSince: NOW,
      paidPlan: "plus",
      providerSubscriptionId: "sub_1",
      currency: "USD",
      storageBlocks: 2,
      extraMailboxes: 3,
      periodPaidStorageBlocks: 2,
      periodPaidExtraMailboxes: 3,
      checkoutPendingUntil: null,
      lastInvoiceId: "in_new",
    });
    expect(changes).toEqual([
      { kind: "state_changed", from: "free", to: "active", reason: "checkout_paid" },
      { kind: "plan_changed", from: "free", to: "plus", source: "stripe" },
      { kind: "addons_changed", storageBlocks: { from: 0, to: 2 }, extraMailboxes: { from: 0, to: 3 } },
      { kind: "payment_succeeded", invoiceId: "in_new", amountMinor: 900 },
    ]);
  });

  it("active → past_due on a failed renewal; the paid plan's limits stay", () => {
    const failing = sub({
      status: "past_due",
      latestInvoice: { ...sub().latestInvoice!, id: "in_2", status: "open", billingReason: "subscription_cycle" },
    });
    const { next, changes } = deriveBilling(paid(), failing, [ev("invoice.payment_failed")], ctx());
    expect(next.state).toBe("past_due");
    expect(effectivePlan(next)).toBe("plus");
    expect(changes).toContainEqual({ kind: "state_changed", from: "active", to: "past_due", reason: "payment_failed" });
    expect(changes).toContainEqual({
      kind: "payment_failed",
      invoiceId: "obj_invoice.payment_failed",
      amountMinor: null,
    });
  });

  it("a payment failure event naming the latest invoice carries its amount", () => {
    const failing = sub({
      status: "past_due",
      latestInvoice: { ...sub().latestInvoice!, id: "obj_invoice.payment_failed", status: "open", amountMinor: 900 },
    });
    const { changes } = deriveBilling(paid(), failing, [ev("invoice.payment_failed")], ctx());
    expect(changes).toContainEqual({
      kind: "payment_failed",
      invoiceId: "obj_invoice.payment_failed",
      amountMinor: 900,
    });
  });

  it("past_due → active when the retry pays", () => {
    const renewed = sub({
      latestInvoice: { ...sub().latestInvoice!, id: "in_2", billingReason: "subscription_cycle" },
    });
    const { next, changes } = deriveBilling(
      paid({ state: "past_due", lastInvoiceId: "in_2", lastInvoiceStatus: "open" }),
      renewed,
      [],
      ctx(),
    );
    expect(next.state).toBe("active");
    expect(changes[0]).toEqual({ kind: "state_changed", from: "past_due", to: "active", reason: "payment_recovered" });
    expect(changes).toContainEqual({ kind: "payment_succeeded", invoiceId: "in_2", amountMinor: 900 });
  });

  it("past_due → restricted when retries run out (unpaid); restrictedAt is kept while it stays restricted", () => {
    const { next, changes } = deriveBilling(paid({ state: "past_due" }), sub({ status: "unpaid" }), [], ctx());
    expect(next).toMatchObject({ state: "restricted", restrictedAt: NOW });
    expect(changes[0]).toEqual({
      kind: "state_changed",
      from: "past_due",
      to: "restricted",
      reason: "retries_exhausted",
    });
    const later = new Date(NOW.getTime() + DAY);
    const again = deriveBilling(next, sub({ status: "unpaid" }), [], { now: later, holdCount: 0 });
    expect(again.next.restrictedAt).toEqual(NOW);
    expect(again.changes).toEqual([]);
  });

  it("a paused subscription restricts with reason paused", () => {
    const { changes } = deriveBilling(paid(), sub({ status: "paused" }), [], ctx());
    expect(changes[0]).toEqual({ kind: "state_changed", from: "active", to: "restricted", reason: "paused" });
  });

  it("restricted → active when the open invoice is paid", () => {
    const { next } = deriveBilling(paid({ state: "restricted", restrictedAt: T0 }), sub(), [], ctx());
    expect(next).toMatchObject({ state: "active", restrictedAt: null });
  });

  it("a dispute restricts at once, from the provider or from an event, on any status", () => {
    const fromProvider = deriveBilling(paid(), sub({ disputed: true }), [], ctx());
    expect(fromProvider.next).toMatchObject({ state: "restricted", disputedAt: NOW, restrictedAt: NOW });
    expect(fromProvider.changes).toContainEqual({
      kind: "state_changed",
      from: "active",
      to: "restricted",
      reason: "dispute_opened",
    });
    expect(fromProvider.changes).toContainEqual({ kind: "dispute_opened" });
    const fromEvent = deriveBilling(
      paid({ state: "past_due" }),
      sub({ status: "past_due" }),
      [ev("charge.dispute.created")],
      ctx(),
    );
    expect(fromEvent.next.state).toBe("restricted");
  });

  const closedAs = (outcome: DisputeOutcome | null, at: Date = NOW, id = "evt_closed"): PendingBillingEvent => ({
    ...ev("charge.dispute.closed", at, id),
    objectId: "dp_1",
    disputeOutcome: outcome,
  });

  it("a dispute is sticky until it closes as won, then the provider's state returns", () => {
    const disputed = paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 });
    expect(deriveBilling(disputed, sub(), [], ctx()).next.state).toBe("restricted");
    const closed = deriveBilling(disputed, sub(), [closedAs("won")], ctx());
    expect(closed.next).toMatchObject({ state: "active", disputedAt: null, restrictedAt: null });
    expect(closed.changes).toContainEqual({
      kind: "state_changed",
      from: "restricted",
      to: "active",
      reason: "dispute_closed",
    });
    expect(closed.changes).toContainEqual({ kind: "dispute_closed", disputeId: "dp_1", outcome: "won" });
    const toPastDue = deriveBilling(disputed, sub({ status: "past_due" }), [closedAs("won")], ctx());
    expect(toPastDue.changes[0]).toMatchObject({ to: "past_due", reason: "dispute_closed" });
  });

  it.each([
    ["won", "active", null],
    ["warning_closed", "active", null],
    ["lost", "restricted", T0],
    ["open", "restricted", T0],
    [null, "restricted", T0],
  ] as const)(
    "a dispute closed as %s → %s (only won or a closed inquiry lifts it; ADR-0029 §5)",
    (outcome, state, disputedAt) => {
      const disputed = paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 });
      const { next, changes } = deriveBilling(disputed, sub(), [closedAs(outcome)], ctx());
      expect(next).toMatchObject({ state, disputedAt });
      expect(changes).toContainEqual({ kind: "dispute_closed", disputeId: "dp_1", outcome: outcome ?? "unknown" });
    },
  );

  it("a lost dispute stays restricted on later syncs, until staff clear it", () => {
    const lost = deriveBilling(
      paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 }),
      sub(),
      [closedAs("lost")],
      ctx(),
    ).next;
    const later = deriveBilling(lost, sub(), [], { now: new Date(NOW.getTime() + 40 * DAY), holdCount: 0 });
    expect(later.next.state).toBe("restricted");
    expect(later.changes).toEqual([]);
    expect(restrictedTimedOut(later.next, new Date(NOW.getTime() + 40 * DAY))).toBe(false);
    // Staff clear (a later slice) sets disputedAt to null; the provider's state then returns.
    expect(deriveBilling({ ...later.next, disputedAt: null }, sub(), [], ctx()).next.state).toBe("active");
  });

  it("a lost dispute reported by the provider restricts even without an event", () => {
    const { next, changes } = deriveBilling(paid(), sub({ disputeLost: true }), [], ctx());
    expect(next).toMatchObject({ state: "restricted", disputedAt: NOW });
    expect(changes).toContainEqual({ kind: "dispute_opened" });
  });

  it("a lost dispute on a subscription that then ends lapses like any other end", () => {
    const lost = paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 });
    expect(deriveBilling(lost, null, [], ctx(1)).next.state).toBe("lapsed");
  });

  it("the later of reordered dispute events wins, whatever order they arrive in", () => {
    const opened = { ...ev("charge.dispute.created", new Date(NOW.getTime() - 2000), "evt_a"), objectId: "dp_1" };
    const closedLater = closedAs("won", new Date(NOW.getTime() - 1000), "evt_b");
    const a = deriveBilling(paid(), sub(), [closedLater, opened], ctx());
    const b = deriveBilling(paid(), sub(), [opened, closedLater], ctx());
    expect(a.next).toEqual(b.next);
    expect(a.next.state).toBe("active");
    expect(a.processedEventIds).toEqual(["evt_a", "evt_b"]);
    const lostLater = closedAs("lost", new Date(NOW.getTime() - 1000), "evt_b");
    expect(deriveBilling(paid(), sub(), [lostLater, opened], ctx()).next.state).toBe("restricted");
  });

  const tracked = (disputeId: string, status: "open" | "won" | "lost" | "warning_closed" | "cleared") => ({
    accountId: ACCOUNT,
    disputeId,
    status,
    openedAt: T0,
    closedAt: status === "open" ? null : T0,
    updatedAt: T0,
  });

  it("disputes are tracked one by one: a won one never clears another lost or still open", () => {
    const disputed = paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 });
    const wonOther = { ...closedAs("won"), objectId: "dp_2" };
    const withLost = deriveBilling(disputed, sub(), [wonOther], { ...ctx(), disputes: [tracked("dp_1", "lost")] });
    expect(withLost.next).toMatchObject({ state: "restricted", disputedAt: T0 });
    expect(withLost.disputes).toEqual([expect.objectContaining({ disputeId: "dp_2", status: "won", closedAt: NOW })]);
    expect(withLost.changes).toContainEqual({ kind: "dispute_closed", disputeId: "dp_2", outcome: "won" });
    const withOpen = deriveBilling(disputed, sub(), [wonOther], { ...ctx(), disputes: [tracked("dp_1", "open")] });
    expect(withOpen.next.state).toBe("restricted");
    // Once every tracked dispute is won (or cleared by staff), the provider's state returns.
    const allWon = deriveBilling(disputed, sub(), [wonOther], { ...ctx(), disputes: [tracked("dp_1", "cleared")] });
    expect(allWon.next).toMatchObject({ state: "active", disputedAt: null });
  });

  it("a fresh read closes a tracked open dispute without its event; a staff clear is never undone", () => {
    const disputed = paid({ state: "restricted", restrictedAt: T0, disputedAt: T0 });
    const healed = deriveBilling(disputed, sub(), [], {
      ...ctx(),
      disputes: [tracked("dp_1", "open")],
      disputeStatuses: new Map([["dp_1", "won"]]),
    });
    expect(healed.next.state).toBe("active");
    expect(healed.changes).toContainEqual({ kind: "dispute_closed", disputeId: "dp_1", outcome: "won" });
    const cleared = deriveBilling(paid(), sub(), [closedAs("lost")], {
      ...ctx(),
      disputes: [tracked("dp_1", "cleared")],
      disputeStatuses: new Map([["dp_1", "lost"]]),
    });
    expect(cleared.next.state).toBe("active");
    expect(cleared.disputes).toEqual([]);
  });

  it("a created event arriving after its close never reopens the dispute", () => {
    const late = { ...ev("charge.dispute.created"), objectId: "dp_1" };
    const out = deriveBilling(paid(), sub(), [late], { ...ctx(), disputes: [tracked("dp_1", "won")] });
    expect(out.next.state).toBe("active");
    expect(out.disputes).toEqual([]);
  });

  it("the provider still reporting a dispute keeps it open despite a won close", () => {
    const { next } = deriveBilling(paid({ disputedAt: T0 }), sub({ disputed: true }), [closedAs("won")], ctx());
    expect(next.state).toBe("restricted");
  });

  it("cancel at period end stays active with cancelAt; undo clears it", () => {
    const end = new Date("2027-11-01T00:00:00Z");
    const scheduled = deriveBilling(paid(), sub({ cancelAt: end }), [], ctx());
    expect(scheduled.next).toMatchObject({ state: "active", cancelAt: end });
    expect(scheduled.changes).toEqual([{ kind: "cancel_scheduled", at: end }]);
    const undone = deriveBilling(scheduled.next, sub(), [], ctx());
    expect(undone.changes).toEqual([{ kind: "cancel_undone" }]);
  });

  it("the period ends (no live subscription) with holds → lapsed; the customer and currency are kept", () => {
    const { next, changes } = deriveBilling(paid({ storageBlocks: 1, cancelAt: T0 }), null, [], ctx(3));
    expect(next).toMatchObject({
      state: "lapsed",
      lapsedAt: NOW,
      planSource: "none",
      paidPlan: null,
      providerSubscriptionId: null,
      providerCustomerId: "cus_1",
      currency: "USD",
      storageBlocks: 0,
      cancelAt: null,
    });
    expect(changes).toEqual([
      { kind: "state_changed", from: "active", to: "lapsed", reason: "subscription_ended" },
      { kind: "plan_changed", from: "plus", to: "free", source: "none" },
      { kind: "addons_changed", storageBlocks: { from: 1, to: 0 }, extraMailboxes: { from: 0, to: 0 } },
      { kind: "holds_needed" },
    ]);
  });

  it("a paid plan ending with nothing to hold goes straight to free", () => {
    const { next } = deriveBilling(paid(), sub({ status: "canceled" }), [], ctx(0));
    expect(next).toMatchObject({ state: "free", lapsedAt: null });
  });

  it("lapsed → free once the Owner resolved every hold; lapsedAt stays while holds remain", () => {
    const lapsed = free({ state: "lapsed", lapsedAt: T0 });
    expect(deriveBilling(lapsed, null, [], ctx(2)).next).toMatchObject({ state: "lapsed", lapsedAt: T0 });
    const resolved = deriveBilling(lapsed, null, [], ctx(0));
    expect(resolved.next.state).toBe("free");
    expect(resolved.changes).toEqual([{ kind: "state_changed", from: "lapsed", to: "free", reason: "holds_resolved" }]);
  });

  it("lapsed → active on a new checkout lifts every hold", () => {
    const { next, changes } = deriveBilling(
      free({ state: "lapsed", lapsedAt: T0 }),
      sub({ subscriptionId: "sub_2" }),
      [],
      ctx(2),
    );
    expect(next).toMatchObject({ state: "active", lapsedAt: null, providerSubscriptionId: "sub_2" });
    expect(changes[0]).toEqual({ kind: "state_changed", from: "lapsed", to: "active", reason: "resubscribed" });
    expect(changes).toContainEqual({ kind: "holds_lifted" });
  });

  it("a comp is active until compUntil, then lapses (comp_ended)", () => {
    const until = new Date(NOW.getTime() + DAY);
    const comp = free({ state: "active", planSource: "comp", paidPlan: "supporter", compUntil: until });
    const during = deriveBilling(comp, null, [], ctx(1));
    expect(during.next).toMatchObject({ state: "active", currentPeriodEnd: until, compUntil: until });
    expect(during.changes).toEqual([]);
    const after = deriveBilling(comp, null, [], { now: new Date(until.getTime() + 1), holdCount: 1 });
    expect(after.next).toMatchObject({ state: "lapsed", compUntil: null, paidPlan: null });
    expect(after.changes[0]).toMatchObject({ reason: "comp_ended" });
  });

  it("a comp start from free is reported as comp_started; a subscription replaces a comp at once", () => {
    const until = new Date(NOW.getTime() + DAY);
    const started = deriveBilling(
      free({ state: "free", planSource: "comp", paidPlan: "plus", compUntil: until }),
      null,
      [],
      ctx(),
    );
    expect(started.changes[0]).toMatchObject({ to: "active", reason: "comp_started" });
    const replaced = deriveBilling(started.next, sub(), [], ctx());
    expect(replaced.next).toMatchObject({ planSource: "stripe", compUntil: null });
  });

  it("a staff grant stays active with no subscription; from free it is reported as staff_grant", () => {
    const staff = free({ planSource: "staff", paidPlan: "plus" });
    const { next, changes } = deriveBilling(staff, null, [], ctx());
    expect(next.state).toBe("active");
    expect(changes[0]).toMatchObject({ reason: "staff_grant" });
  });

  it("Plus → Supporter and a Supporter amount change are reported", () => {
    const switched = deriveBilling(paid(), sub({ plan: "supporter", planAmountMinor: 2000 }), [], ctx());
    expect(switched.next.paidPlan).toBe("supporter");
    expect(switched.changes).toEqual([{ kind: "plan_changed", from: "plus", to: "supporter", source: "stripe" }]);
    const amount = deriveBilling(switched.next, sub({ plan: "supporter", planAmountMinor: 5000 }), [], ctx());
    expect(amount.changes).toEqual([{ kind: "supporter_amount_changed", from: 2000, to: 5000 }]);
  });

  it("a decrease keeps the period's paid capacity; an add-on proration invoice doesn't reset it", () => {
    const start = paid({ storageBlocks: 3, periodPaidStorageBlocks: 3 });
    const lowered = deriveBilling(start, sub({ storageBlocks: 1 }), [], ctx());
    expect(lowered.next).toMatchObject({ storageBlocks: 1, periodPaidStorageBlocks: 3 });
    const proration = sub({
      storageBlocks: 4,
      latestInvoice: { ...sub().latestInvoice!, id: "in_pr", billingReason: "other", amountMinor: 500 },
    });
    const raised = deriveBilling(lowered.next, proration, [], ctx());
    expect(raised.next).toMatchObject({ storageBlocks: 4, periodPaidStorageBlocks: 3 });
    const renewal = sub({
      storageBlocks: 1,
      latestInvoice: { ...sub().latestInvoice!, id: "in_cycle", billingReason: "subscription_cycle" },
    });
    expect(deriveBilling(raised.next, renewal, [], ctx()).next.periodPaidStorageBlocks).toBe(1);
  });

  it("a dashboard refund is reported with the refunded amount when known", () => {
    const refunded = sub({ latestInvoice: { ...sub().latestInvoice!, refundedMinor: 900 } });
    expect(deriveBilling(paid(), refunded, [ev("charge.refunded")], ctx()).changes).toEqual([
      { kind: "refunded", objectId: "obj_charge.refunded", amountMinor: 900 },
    ]);
    expect(deriveBilling(paid(), null, [ev("charge.refunded")], ctx(0)).changes).toContainEqual({
      kind: "refunded",
      objectId: "obj_charge.refunded",
      amountMinor: null,
    });
  });

  it("is deterministic: the same inputs give the same row, and unrelated events change nothing", () => {
    const a = deriveBilling(paid(), sub(), [ev("customer.subscription.updated")], ctx());
    const b = deriveBilling(paid(), sub(), [ev("customer.subscription.updated")], ctx());
    expect(a).toEqual(b);
    expect(a.changes).toEqual([]);
  });
});

describe("timers and mailbox access", () => {
  it("a restriction times out after restrictedDays, never while a dispute is open", () => {
    const at = (days: number) => new Date(T0.getTime() + days * DAY);
    const r = { state: "restricted" as const, restrictedAt: T0, disputedAt: null };
    expect(restrictedTimedOut(r, at(29.99))).toBe(false);
    expect(restrictedTimedOut(r, at(30))).toBe(true);
    expect(restrictedTimedOut({ ...r, disputedAt: T0 }, at(60))).toBe(false);
    expect(restrictedTimedOut({ ...r, state: "active" }, at(60))).toBe(false);
    expect(restrictedTimedOut({ ...r, restrictedAt: null }, at(60))).toBe(false);
  });

  it("a comp ends at compUntil", () => {
    expect(compEnded({ planSource: "comp", compUntil: NOW }, NOW)).toBe(true);
    expect(compEnded({ planSource: "comp", compUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(false);
    expect(compEnded({ planSource: "stripe", compUntil: NOW }, NOW)).toBe(false);
    expect(compEnded({ planSource: "comp", compUntil: null }, NOW)).toBe(false);
  });

  it("restricted blocks sending; a held mailbox blocks sending, then receiving after its window", () => {
    expect(billingMailboxAccess("active", null, NOW)).toBe("active");
    expect(billingMailboxAccess("past_due", null, NOW)).toBe("active");
    expect(billingMailboxAccess("restricted", null, NOW)).toBe("send_blocked");
    const until = new Date(NOW.getTime() + DAY);
    expect(billingMailboxAccess("lapsed", { receiveUntil: until }, NOW)).toBe("send_blocked");
    expect(billingMailboxAccess("lapsed", { receiveUntil: until }, until)).toBe("receive_blocked");
    expect(billingMailboxAccess("lapsed", { receiveUntil: null }, NOW)).toBe("send_blocked");
  });
});
