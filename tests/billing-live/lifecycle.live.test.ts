// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Live verification of billing against the payment processor's **test mode** with test clocks (ADR-0029 §10, slice
 * 14). Manual and local only: `npm run test:billing-live` with test keys in `.env`. Without a key every test is
 * skipped; a live key aborts the run before any request; CI never has a key and never runs it.
 *
 * Each case makes its own test clock and a customer on it, subscribes with the processor's test payment methods,
 * moves the clock (renewals, retries, period ends), waits until the clock is ready, runs `billing.sync` for the
 * account directly (no webhook forwarding needed) and checks our state, holds and audit entries against the
 * in-memory repositories; then deletes the clock. Every arrow of the §5 state table that the processor drives has a
 * case, and the slice 14 checklist items of the ADR updates are asserted where the processor answers them:
 *
 *   - the field shapes the adapter reads at the pinned API version (periods on the items, `status_transitions.paid_at`,
 *     refunds and disputes through the invoice's payments, the invoice `lines` with quantity, `period.end`, the price
 *     under `pricing.price_details.price` and the proration flag);
 *   - that a dispute object carries no customer, and that the dispute read (payment intent and charge expanded)
 *     names ours; the statuses for won, lost and a closed inquiry (`won`, `lost`, `warning_closed`);
 *   - `invoices/create_preview` with `always_invoice`, and whether the confirming preview equals what the update
 *     charges (per-second proration);
 *   - that a renewal invoice bills the add-on quantities in force at the cycle;
 *   - the catalogue check against `plans.ts`.
 *
 * Mail-server items of the checklist (held submissions released after a restriction, `FUTURERELEASE`) are not the
 * processor's and are checked on the compose stack, not here. Record the run's date, key mode and results in the
 * handoff (ADR-0029 §10).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createStripeBillingProvider } from "@anhourmail/adapters/billing-stripe";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import type { Actor, Deps } from "@anhourmail/core";
import {
  type BillingContext,
  type BillingProvider,
  cancelBillingForDeletion,
  checkBillingCatalogue,
  clearDisputes,
  defaultBilling,
  ingestBillingEvent,
  refundSubscription,
  runBillingTimers,
  syncAccountBilling,
} from "@anhourmail/core/billing";
import { BILLING, PLANS } from "@anhourmail/shared/plans";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { liveSettings } from "./live-env";
import { TestMode } from "./test-mode";

const settings = liveSettings();
const config = "config" in settings ? settings.config : null;
const enabled = config !== null;
const DAY = 86_400_000;
const ACCOUNT = "4ccc0000-0000-4000-8000-00000000000a";
const SESSION = { sessionId: "live-session" };
const req = { requestId: "billing-live", ip: null, userAgent: null };

const owner: Actor = {
  kind: "user",
  userId: "live-owner",
  email: "live-owner@example.test",
  platformRoles: [],
  memberships: [{ accountId: ACCOUNT, role: "owner" }],
  suspended: false,
};
const billingStaff: Actor = { ...owner, userId: "live-staff", platformRoles: ["billing_admin"], memberships: [] };

const clocks: string[] = [];
const api = config ? new TestMode(config.secretKey) : null;

afterEach(async () => {
  for (const id of clocks.splice(0)) await api?.deleteClock(id);
});

/** Our side: memory repositories with one account (two platform mailboxes, so a lapse holds one) on our own clock. */
function world() {
  if (!config || !api) throw new Error("not enabled");
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  let now = new Date();
  const deps: Deps = { uow, clock: { now: () => now }, platform: PUBLIC_PLATFORM };
  s.accounts.push({ id: ACCOUNT, name: "Live suite", plan: "free" });
  s.memberships.push({ userId: "live-owner", accountId: ACCOUNT, role: "owner" });
  for (const u of ["live-owner", "live-staff"]) {
    s.stepUps.push({ userId: u, sessionId: SESSION.sessionId, expiresAt: new Date("2999-01-01") });
  }
  const box = (n: number, userId: string | null) => ({
    id: `4ccc0000-0000-4000-8000-00000000010${String(n)}`,
    accountId: ACCOUNT,
    userId,
    address: `live-${String(n)}@${PUBLIC_PLATFORM.domain}`,
    status: "active" as const,
    quotaBytes: 100 * 1024 * 1024,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  s.mailboxes.push(box(1, "live-owner"), box(2, null));
  const provider: BillingProvider = createStripeBillingProvider(config);
  const ctx: BillingContext = {
    provider,
    appUrl: "http://localhost:43200",
    redirectOrigins: ["https://checkout.stripe.com", "https://billing.stripe.com"],
    paidPlansOpen: true,
  };
  const row = async () => (await uow.run((r) => r.billing.get(ACCOUNT))) ?? defaultBilling(ACCOUNT, "free", now);
  const audits = (action: string) => s.audit.filter((e) => e.action === action);
  const prices = config.prices;
  const plusItem = { price: prices.plus[0] ?? "" };
  const blocks = (quantity: number) => ({ price: prices.storageBlock[0] ?? "", quantity });

  /** A clock at the real now, our clock on it, and a customer on the clock tied to our account. */
  const start = async (name: string, paymentMethod = "pm_card_visa") => {
    const clock = await api.clock(new Date(), `billing-live ${name}`);
    clocks.push(clock);
    now = await api.frozenTime(clock);
    const customerId = await api.customer(clock, ACCOUNT, paymentMethod);
    await uow.run((r) => r.billing.save({ ...defaultBilling(ACCOUNT, "free", now), providerCustomerId: customerId }));
    return { clock, customerId };
  };
  /** Moves the processor's clock (and ours with it) and syncs the account. */
  const advance = async (clock: string, days: number) => {
    await api.advance(clock, new Date((await api.frozenTime(clock)).getTime() + days * DAY));
    now = await api.frozenTime(clock);
    return sync();
  };
  const sync = async () => {
    await syncAccountBilling(deps, provider, ACCOUNT);
    return row();
  };
  return {
    uow,
    s,
    deps,
    provider,
    ctx,
    row,
    audits,
    plusItem,
    blocks,
    start,
    advance,
    sync,
    setNow: (d: Date) => {
      now = d;
    },
    now: () => now,
  };
}

/** The payment intent of a new subscription's first invoice, and the dispute the test card opens on it. */
async function disputeOn(
  sub: Record<string, unknown> | undefined,
): Promise<{ intent: string; dispute: Record<string, unknown> }> {
  const inv = (sub?.latest_invoice ?? {}) as { id?: unknown };
  const invoiceId = typeof inv.id === "string" ? inv.id : "";
  let intent = "";
  await api?.until(async () => (intent = (await api.invoicePaymentIntent(invoiceId)) ?? "") !== "");
  let found: Record<string, unknown>[] = [];
  await api?.until(async () => (found = await api.disputesOf(intent)).length > 0);
  return { intent, dispute: found[0] ?? {} };
}

const idOf = (d: Record<string, unknown>): string => (typeof d.id === "string" ? d.id : "");

describe.skipIf(!enabled)("billing live suite (processor test mode, test clocks)", () => {
  it("the catalogue matches plans.ts", async () => {
    const w = world();
    expect(await checkBillingCatalogue(w.deps, w.provider)).toMatchObject({ drift: [] });
  });

  it("free → active on a paid first invoice; the invoice lines are read at the pinned version", async () => {
    const w = world();
    const { customerId } = await w.start("first payment");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem, w.blocks(1)]);
    const sub = await w.provider.getSubscription(customerId);
    expect(sub).toMatchObject({ status: "active", plan: "plus", storageBlocks: 1, currency: "USD" });
    expect(sub?.latestInvoice).toMatchObject({
      status: "paid",
      billingReason: "subscription_create",
      storageBlocks: 1,
    });
    expect(sub?.latestInvoice?.paidAt).not.toBeNull();
    expect(sub?.latestInvoice?.periodEnd?.getTime()).toBe(sub?.currentPeriodEnd.getTime());
    expect(sub?.planAmountMinor).toBe(PLANS.plus.price?.USD);
    const b = await w.sync();
    expect(b).toMatchObject({ state: "active", paidPlan: "plus", periodPaidStorageBlocks: 1 });
    expect(w.audits("billing.state_changed").at(-1)?.meta).toMatchObject({
      toState: "active",
      reason: "checkout_paid",
    });
    expect(w.audits("billing.payment_succeeded")).toHaveLength(1);
  });

  it("active → past_due on a failed renewal → restricted when retries run out → active when the open invoice is paid", async () => {
    const w = world();
    const { clock, customerId } = await w.start("renewal fails");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem]);
    expect((await w.sync()).state).toBe("active");
    await api?.usePaymentMethod(customerId, "pm_card_chargeCustomerFail");
    const pastDue = await w.advance(clock, 366);
    expect(pastDue.state).toBe("past_due");
    expect(w.audits("billing.state_changed").at(-1)?.meta).toMatchObject({ toState: "past_due" });
    // Smart Retries run for up to a few weeks; the dashboard is set to mark the subscription unpaid when they end.
    let state = pastDue.state;
    for (let i = 0; i < 6 && state === "past_due"; i++) state = (await w.advance(clock, 10)).state;
    expect(state, "retries exhausted must mark the subscription unpaid (dashboard setting), not cancel it").toBe(
      "restricted",
    );
    expect(w.audits("billing.state_changed").at(-1)?.meta).toMatchObject({ reason: "retries_exhausted" });
    await api?.usePaymentMethod(customerId, "pm_card_visa");
    const open = (await w.provider.getSubscription(customerId))?.latestInvoice;
    expect(open?.status).toBe("open");
    await api?.payInvoice(open?.id ?? "");
    expect((await w.sync()).state).toBe("active");
  });

  it("restricted past restrictedDays: billing.timers ends the subscription and the account lapses with holds", async () => {
    const w = world();
    const { clock, customerId } = await w.start("restricted timeout");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem]);
    await w.sync();
    await api?.usePaymentMethod(customerId, "pm_card_chargeCustomerFail");
    let b = await w.advance(clock, 366);
    for (let i = 0; i < 6 && b.state === "past_due"; i++) b = await w.advance(clock, 10);
    expect(b.state).toBe("restricted");
    w.setNow(new Date((b.restrictedAt ?? w.now()).getTime() + BILLING.restrictedDays * DAY + 1000));
    expect((await runBillingTimers(w.deps, w.provider)).restrictedEnded).toBe(1);
    const lapsed = await w.sync();
    expect(lapsed.state).toBe("lapsed");
    expect(await w.uow.run((r) => r.billing.holds(ACCOUNT))).toHaveLength(1);
    expect(w.audits("billing.holds_applied")).toHaveLength(1);
  });

  it("cancel at period end: active with the date set, then ended at the period's end (Free: nothing over Free)", async () => {
    const w = world();
    w.s.mailboxes.pop(); // one mailbox: nothing to hold
    const { clock, customerId } = await w.start("cancel at period end");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem]);
    const active = await w.sync();
    await w.provider.cancel({
      subscriptionId: active.providerSubscriptionId ?? "",
      when: "period_end",
      intentId: `live-${clock}`,
    });
    const scheduled = await w.sync();
    expect(scheduled).toMatchObject({ state: "active" });
    expect(scheduled.cancelAt).not.toBeNull();
    expect(w.audits("billing.cancel_scheduled")).toHaveLength(1);
    expect((await w.advance(clock, 367)).state).toBe("free");
  });

  it("the self-service refund within the window: refunded in full, ended now, lapsed with holds", async () => {
    const w = world();
    const { customerId } = await w.start("refund");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem]);
    await w.sync();
    const out = await refundSubscription(w.deps, w.ctx, owner, ACCOUNT, SESSION, req);
    expect(out).toMatchObject({ amountMinor: PLANS.plus.price?.USD, currency: "USD" });
    const after = await w.sync();
    expect(after.state).toBe("lapsed");
    expect(after.selfServiceRefundAt).not.toBeNull();
  });

  it("a dispute restricts at once; its object carries no customer; the read names ours; won lifts it", async () => {
    const w = world();
    const { customerId } = await w.start("dispute won", "pm_card_createDispute");
    const { intent, dispute } = await disputeOn(await api?.subscribe(customerId, ACCOUNT, [w.plusItem]));
    const disputeId = idOf(dispute);
    // Checklist: the dispute object at the pinned version doesn't carry the customer (we resolve it through the payment).
    expect(
      dispute.customer ?? null,
      "the dispute object carries a customer: ingestion could skip the lookup",
    ).toBeNull();
    const read = await w.provider.getDispute(disputeId);
    expect(read).toMatchObject({ status: "open", customerId });
    expect((await w.sync()).state).toBe("restricted");

    await api?.decideDispute(disputeId, "winning_evidence");
    await api?.until(async () => (await w.provider.getDispute(disputeId)).status !== "open");
    expect((await w.provider.getDispute(disputeId)).status).toBe("won");
    // The close as a trigger (events carry no payload): the sync reads the outcome itself.
    await ingestBillingEvent(
      w.deps,
      {
        id: `evt_live_${disputeId}`,
        type: "charge.dispute.closed",
        createdAt: w.now(),
        livemode: false,
        customerId,
        objectId: disputeId,
        paymentIntentId: intent,
        chargeId: null,
        accountIdHint: ACCOUNT,
      },
      w.now(),
    );
    expect((await w.sync()).state).toBe("active");
  });

  it("a lost dispute keeps sending paused until staff clear it", async () => {
    const w = world();
    const { customerId } = await w.start("dispute lost", "pm_card_createDispute");
    const id = idOf((await disputeOn(await api?.subscribe(customerId, ACCOUNT, [w.plusItem]))).dispute);
    await api?.decideDispute(id, "losing_evidence");
    await api?.until(async () => (await w.provider.getDispute(id)).status !== "open");
    expect((await w.provider.getDispute(id)).status).toBe("lost");
    expect((await w.provider.getSubscription(customerId))?.latestDisputes).toContainEqual({ id, status: "lost" });
    expect((await w.sync()).state).toBe("restricted");
    const shown = (await w.uow.run((r) => r.billing.disputes(ACCOUNT))).map((d) => d.disputeId);
    expect(shown).toEqual([id]);
    expect(
      await clearDisputes(w.deps, w.ctx, billingStaff, ACCOUNT, { disputeIds: shown }, SESSION, req),
    ).toMatchObject({ cleared: 1 });
    expect((await w.sync()).state).toBe("active");
  });

  it("an inquiry closed without a chargeback reads as warning_closed and lifts the restriction", async () => {
    const w = world();
    const { customerId } = await w.start("inquiry", "pm_card_createDisputeInquiry");
    const id = idOf((await disputeOn(await api?.subscribe(customerId, ACCOUNT, [w.plusItem]))).dispute);
    expect((await w.sync()).state).toBe("restricted");
    await api?.decideDispute(id, "winning_evidence");
    await api?.until(async () => (await w.provider.getDispute(id)).status !== "open");
    expect((await w.provider.getDispute(id)).status).toBe("warning_closed");
    expect((await w.sync()).state).toBe("active");
  });

  it("a deleted past-due subscription: is its open invoice still collected? Ours voids it before ending it", async () => {
    const w = world();
    // Checklist (run-69 N3): what the processor does with the open renewal invoice of a subscription deleted while
    // past due. Observed, not assumed: the result is printed for the handoff.
    const plain = await w.start("deleted past due, not voided");
    await api?.subscribe(plain.customerId, ACCOUNT, [w.plusItem]);
    await w.sync();
    await api?.usePaymentMethod(plain.customerId, "pm_card_chargeCustomerFail");
    expect((await w.advance(plain.clock, 366)).state).toBe("past_due");
    const open = (await w.provider.getSubscription(plain.customerId))?.latestInvoice?.id ?? "";
    await w.provider.cancel({
      subscriptionId: (await w.row()).providerSubscriptionId ?? "",
      when: "now",
      intentId: `live-plain-${plain.clock}`,
    });
    await api?.usePaymentMethod(plain.customerId, "pm_card_visa");
    await api?.advance(plain.clock, new Date((await api.frozenTime(plain.clock)).getTime() + 10 * DAY));
    const left = await api?.invoice(open);
    process.stdout.write(
      `billing-live: a deleted past-due subscription's open invoice after 10 days: status ${left?.status ?? "?"}, ` +
        `attempts ${String(left?.attempts ?? 0)}, next attempt ${left?.nextAttempt === null ? "none" : "scheduled"}\n`,
    );

    // Ours: the deletion ends it with its open invoices voided, so nothing can be collected afterwards.
    w.uow.state.billing = [];
    const ours = await w.start("deleted past due, voided");
    await api?.subscribe(ours.customerId, ACCOUNT, [w.plusItem]);
    await w.sync();
    await api?.usePaymentMethod(ours.customerId, "pm_card_chargeCustomerFail");
    expect((await w.advance(ours.clock, 366)).state).toBe("past_due");
    const ourOpen = (await w.provider.getSubscription(ours.customerId))?.latestInvoice?.id ?? "";
    expect(await cancelBillingForDeletion(w.deps, w.provider, ACCOUNT, "now", { deleteAfter: w.now() })).toBe("ended");
    await api?.usePaymentMethod(ours.customerId, "pm_card_visa");
    await api?.advance(ours.clock, new Date((await api.frozenTime(ours.clock)).getTime() + 10 * DAY));
    expect(await api?.invoice(ourOpen)).toMatchObject({ status: "void", nextAttempt: null });
  });

  it("3-D Secure required and never completed: incomplete grants nothing", async () => {
    const w = world();
    const { customerId } = await w.start("3ds", "pm_card_authenticationRequired");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem], { payment_behavior: "default_incomplete" });
    expect((await w.provider.getSubscription(customerId))?.status).toBe("incomplete");
    const b = await w.sync();
    expect(b).toMatchObject({ state: "free", paidPlan: null });
    expect(w.audits("billing.state_changed")).toHaveLength(0);
  });

  it("an add-on increase: the confirming preview (always_invoice) equals what the update charges", async () => {
    const w = world();
    const { customerId } = await w.start("add-on increase");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem]);
    const b = await w.sync();
    const change = {
      subscriptionId: b.providerSubscriptionId ?? "",
      intentId: `live-increase-${customerId}`,
      storageBlocks: 1,
      proration: "charge_now" as const,
    };
    const preview = await w.provider.previewChange(change);
    expect(preview.amountDueNowMinor).toBeGreaterThan(0);
    const updated = await w.provider.changeSubscription(change);
    expect(updated.storageBlocks).toBe(1);
    // Per-second proration: if these ever differ, pass a fixed proration time from the preview to the update.
    expect(updated.latestInvoice?.amountMinor, "preview and charge differ: fix the proration time").toBe(
      preview.amountDueNowMinor,
    );
  });

  it("a decrease renews lower: the renewal invoice bills the quantity in force at the cycle", async () => {
    const w = world();
    const { clock, customerId } = await w.start("renewal quantities");
    await api?.subscribe(customerId, ACCOUNT, [w.plusItem, w.blocks(2)]);
    const b = await w.sync();
    await w.provider.changeSubscription({
      subscriptionId: b.providerSubscriptionId ?? "",
      intentId: `live-decrease-${customerId}`,
      storageBlocks: 1,
      proration: "none",
    });
    const renewed = await w.advance(clock, 366);
    expect(renewed).toMatchObject({ state: "active", storageBlocks: 1, periodPaidStorageBlocks: 1 });
    const inv = (await w.provider.getSubscription(customerId))?.latestInvoice;
    expect(inv).toMatchObject({ billingReason: "subscription_cycle", status: "paid", storageBlocks: 1 });
  });

  it("Supporter with an inline yearly price: active at the chosen amount", async () => {
    const w = world();
    const { customerId } = await w.start("supporter");
    const amount = (PLANS.supporter.price?.USD ?? 0) + 100;
    await api?.subscribe(customerId, ACCOUNT, [
      {
        price_data: {
          product: config?.supporterProduct ?? "",
          currency: "usd",
          unit_amount: amount,
          recurring: { interval: "year" },
          tax_behavior: "exclusive",
        },
      },
    ]);
    expect(await w.sync()).toMatchObject({ state: "active", paidPlan: "supporter", planAmountMinor: amount });
  });
});
