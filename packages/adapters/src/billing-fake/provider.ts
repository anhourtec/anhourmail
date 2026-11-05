// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fake billing provider (ADR-0029 §1, §3): the `BillingProvider` port with its state in a `FakeBillingStore`, a
 * clock offset (the test-clock analogue), and events signed with the real webhook scheme, so dev and tests exercise
 * signature checks, ingestion and the sync without a payment processor. Checkout and the portal are our own
 * `/dev/billing/…` pages. Never constructible in production (boot fails; ADR-0029 §3, layer 1).
 */
import { randomBytes } from "node:crypto";

import {
  type BillingProvider,
  BillingProviderError,
  type CatalogueDrift,
  type CheckoutInput,
  isLiveSubStatus,
  type ProviderEvent,
  type ProviderSubscription,
  type SubscriptionChange,
} from "@anhourmail/core/billing";
import { type Currency, PLANS } from "@anhourmail/shared/plans";

import { signatureHeader, verifyWebhookBody } from "../billing-stripe/signature";

import type { FakeBillingState, FakeBillingStore, FakeEvent, FakeInvoice, FakeSubscription } from "./store";

const DAY_MS = 86_400_000;
/** One billing period: the plans are yearly. */
const PERIOD_MS = 365 * DAY_MS;
/** A checkout session lives an hour, like the real one we create. */
const CHECKOUT_TTL_MS = 3_600_000;

export type FakeBillingOptions = {
  store: FakeBillingStore;
  /** The console origin: checkout and portal URLs are its `/dev/billing/…` pages. */
  appUrl: string;
  /** Signs emitted events and verifies deliveries (a dev secret; never a real one). */
  webhookSecret: string;
  clock?: () => Date;
  nodeEnv?: string;
};

/** A signed delivery as the webhook route receives it. */
export type FakeDelivery = { body: string; signature: string };

/** Fake-only controls behind the dev pages' buttons (ADR-0029 §3) and the tests. Each returns the events it emitted. */
/** What the dev checkout and portal pages show about one fake object, and the account it belongs to. */
export type FakeObjectView = {
  accountId: string;
  customerId: string;
  now: Date;
  cardFails: boolean;
  checkout: {
    id: string;
    plan: "plus" | "supporter";
    currency: Currency;
    /** The first year's total: plan plus add-ons, tax-exclusive. */
    totalMinor: number;
    storageBlocks: number;
    extraMailboxes: number;
    open: boolean;
  } | null;
  subscription: {
    id: string;
    status: ProviderSubscription["status"];
    plan: "plus" | "supporter";
    currency: Currency;
    yearMinor: number;
    periodEnd: Date;
    cancelAtPeriodEnd: boolean;
    latestInvoice: { status: FakeInvoice["status"]; amountMinor: number; refundedMinor: number } | null;
    dispute: "open" | "won" | "lost" | "warning_closed" | null;
  } | null;
};

export type FakeBillingControls = {
  now(): Promise<Date>;
  /** A checkout session or a customer as the dev pages show it, or null when the fake doesn't know it. */
  describe(kind: "checkout" | "customer", id: string): Promise<FakeObjectView | null>;
  /** Pays (or declines) an open checkout session; paying creates the subscription and its first invoice. */
  completeCheckout(sessionId: string, outcome: "pay" | "decline"): Promise<FakeEvent[]>;
  /** The customer's card fails (or works again) on every future charge. */
  setCardFails(customerId: string, fails: boolean): Promise<void>;
  /** Moves the fake clock on; renewals and period-end cancellations fall due. */
  advanceClock(days: number): Promise<FakeEvent[]>;
  /**
   * Renews one active subscription now, without moving the clock every fake customer shares (the demo seed's failed
   * renewal): its period starts now and the renewal is charged to its card, so a failing card leaves it past due.
   */
  renewNow(customerId: string): Promise<FakeEvent[]>;
  /** Smart Retries gave up: a past-due subscription becomes unpaid. */
  exhaustRetries(customerId: string): Promise<FakeEvent[]>;
  /** The open invoice is paid (a new card): the subscription is active again. */
  payOpenInvoice(customerId: string): Promise<FakeEvent[]>;
  pause(customerId: string): Promise<FakeEvent[]>;
  openDispute(customerId: string): Promise<FakeEvent[]>;
  /** `warning_closed`: an inquiry closed without a chargeback. */
  closeDispute(customerId: string, outcome: "won" | "lost" | "warning_closed"): Promise<FakeEvent[]>;
  /** A refund made outside our console (the processor's dashboard). */
  refundLatest(customerId: string): Promise<FakeEvent[]>;
  /** Signs and removes every undelivered event, oldest first. */
  drainDeliveries(): Promise<FakeDelivery[]>;
  /** Signs any body at a time (tests). */
  sign(body: string, at: Date): string;
};

export type FakeBillingProvider = BillingProvider & FakeBillingControls;

const fail = (code: ConstructorParameters<typeof BillingProviderError>[0], message: string): never => {
  throw new BillingProviderError(code, message);
};

const nextId = (s: FakeBillingState, prefix: string): string => {
  s.seq += 1;
  return `${prefix}_fake_${String(s.seq)}${randomBytes(4).toString("hex")}`;
};

const unitPrices = (currency: Currency) => ({
  plus: PLANS.plus.price?.[currency] ?? 0,
  storageBlock: PLANS.plus.storageBlockPrice?.[currency] ?? 0,
  extraMailbox: PLANS.plus.extraMailboxPrice?.[currency] ?? 0,
});

const yearAmount = (
  sub: Pick<FakeSubscription, "currency" | "planAmountMinor" | "storageBlocks" | "extraMailboxes">,
) => {
  const p = unitPrices(sub.currency);
  return sub.planAmountMinor + sub.storageBlocks * p.storageBlock + sub.extraMailboxes * p.extraMailbox;
};

const wholeQuantity = (n: number | undefined, what: string): number | undefined => {
  if (n === undefined) return undefined;
  if (!Number.isSafeInteger(n) || n < 0) fail("invalid_request", `${what} must be a whole number`);
  return n;
};

export function createFakeBillingProvider(opts: FakeBillingOptions): FakeBillingProvider {
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === "production") {
    throw new Error("The fake billing provider is for development and tests only (BILLING_PROVIDER=fake refused)");
  }
  const { store, webhookSecret } = opts;
  const appUrl = opts.appUrl.replace(/\/+$/, "");
  const clock = opts.clock ?? (() => new Date());
  const nowOf = (s: FakeBillingState) => clock().getTime() + s.offsetMs;

  const emit = (
    s: FakeBillingState,
    type: string,
    objectKind: string,
    objectId: string,
    customerId: string,
    payment: { paymentIntentId: string; chargeId: string } | null = null,
  ) => {
    const customer = s.customers[customerId];
    const e: FakeEvent = {
      id: nextId(s, "evt"),
      type,
      created: Math.floor(nowOf(s) / 1000),
      objectId,
      objectKind,
      customerId,
      accountId: customer?.accountId ?? "",
      ...(payment ? { paymentIntentId: payment.paymentIntentId, chargeId: payment.chargeId } : {}),
    };
    s.outbox.push(e);
    return e;
  };

  const liveSubs = (s: FakeBillingState, customerId: string) =>
    Object.values(s.subscriptions).filter((x) => x.customerId === customerId && isLiveSubStatus(x.status));

  const liveSub = (s: FakeBillingState, customerId: string): FakeSubscription => {
    const sub = liveSubs(s, customerId)[0];
    if (!sub) return fail("not_found", "no live subscription");
    return sub;
  };

  const subById = (s: FakeBillingState, id: string): FakeSubscription => {
    const sub = s.subscriptions[id];
    if (!sub) return fail("not_found", "no such subscription");
    return sub;
  };

  const toProvider = (s: FakeBillingState, sub: FakeSubscription): ProviderSubscription => {
    const inv = sub.latestInvoiceId ? s.invoices[sub.latestInvoiceId] : undefined;
    return {
      subscriptionId: sub.id,
      customerId: sub.customerId,
      status: sub.status,
      plan: sub.plan,
      currency: sub.currency,
      planAmountMinor: sub.planAmountMinor,
      storageBlocks: sub.storageBlocks,
      extraMailboxes: sub.extraMailboxes,
      currentPeriodStart: new Date(sub.periodStart),
      currentPeriodEnd: new Date(sub.periodEnd),
      cancelAt: sub.cancelAtPeriodEnd ? new Date(sub.periodEnd) : null,
      latestInvoice: inv
        ? {
            id: inv.id,
            status: inv.status,
            amountMinor: inv.amountMinor,
            paidAt: inv.paidAt === null ? null : new Date(inv.paidAt),
            billingReason: inv.billingReason,
            refundedMinor: inv.refundedMinor,
            storageBlocks: inv.storageBlocks ?? null,
            extraMailboxes: inv.extraMailboxes ?? null,
            periodEnd: inv.periodEnd === undefined ? null : new Date(inv.periodEnd),
          }
        : null,
      disputed: inv?.dispute?.status === "open",
      disputeLost: inv?.dispute?.status === "lost",
      latestDisputes: inv?.dispute ? [{ id: inv.dispute.id, status: inv.dispute.status }] : [],
    };
  };

  /** Bills the subscription now; a failing card leaves the invoice open. */
  const invoice = (
    s: FakeBillingState,
    sub: FakeSubscription,
    amountMinor: number,
    billingReason: FakeInvoice["billingReason"],
  ): FakeInvoice => {
    const cardFails = s.customers[sub.customerId]?.cardFails ?? false;
    const inv: FakeInvoice = {
      id: nextId(s, "in"),
      subscriptionId: sub.id,
      customerId: sub.customerId,
      status: cardFails ? "open" : "paid",
      amountMinor,
      currency: sub.currency,
      paidAt: cardFails ? null : nowOf(s),
      billingReason,
      refundedMinor: 0,
      // What this invoice billed, frozen now: later changes to the subscription don't rewrite it.
      storageBlocks: sub.storageBlocks,
      extraMailboxes: sub.extraMailboxes,
      periodEnd: sub.periodEnd,
      paymentIntentId: nextId(s, "pi"),
      chargeId: nextId(s, "ch"),
      dispute: null,
    };
    s.invoices[inv.id] = inv;
    sub.latestInvoiceId = inv.id;
    emit(s, cardFails ? "invoice.payment_failed" : "invoice.paid", "invoice", inv.id, sub.customerId);
    return inv;
  };

  const latestInvoice = (s: FakeBillingState, customerId: string): FakeInvoice => {
    const sub = liveSub(s, customerId);
    const inv = sub.latestInvoiceId ? s.invoices[sub.latestInvoiceId] : undefined;
    if (!inv) return fail("not_found", "no invoice");
    return inv;
  };

  /** Applies a change's quantities and plan; returns the prorated amount due now for increases. */
  const applyChange = (s: FakeBillingState, sub: FakeSubscription, c: SubscriptionChange): number => {
    const storage = wholeQuantity(c.storageBlocks, "storageBlocks") ?? sub.storageBlocks;
    const extra = wholeQuantity(c.extraMailboxes, "extraMailboxes") ?? sub.extraMailboxes;
    const plan = c.plan ?? sub.plan;
    let amount = sub.planAmountMinor;
    if (plan === "supporter") {
      amount = c.supporterAmountMinor ?? (sub.plan === "supporter" ? sub.planAmountMinor : -1);
      if (!Number.isSafeInteger(amount) || amount <= 0) fail("invalid_request", "a Supporter amount is required");
    } else if (plan !== sub.plan) {
      amount = unitPrices(sub.currency).plus;
    }
    const p = unitPrices(sub.currency);
    const remaining = Math.max(0, sub.periodEnd - nowOf(s)) / (sub.periodEnd - sub.periodStart);
    const due =
      c.proration === "charge_now"
        ? Math.round(
            (Math.max(0, storage - sub.storageBlocks) * p.storageBlock +
              Math.max(0, extra - sub.extraMailboxes) * p.extraMailbox) *
              remaining,
          )
        : 0;
    Object.assign(sub, { storageBlocks: storage, extraMailboxes: extra, plan, planAmountMinor: amount });
    return due;
  };

  const checkoutUrl = (id: string) => `${appUrl}/dev/billing/checkout/${encodeURIComponent(id)}`;

  const provider: FakeBillingProvider = {
    kind: "fake",

    ensureCustomer: ({ accountId }) =>
      store.update((s) => {
        const existing = Object.values(s.customers).find((c) => c.accountId === accountId);
        if (existing) return { customerId: existing.id };
        const id = nextId(s, "cus");
        s.customers[id] = { id, accountId, currency: null, cardFails: false };
        return { customerId: id };
      }),

    createCheckout: (i: CheckoutInput) =>
      store.update((s) => {
        const key = `checkout:${i.intentId}`;
        const done = s.applied[key];
        if (done) return { url: checkoutUrl(done) };
        const customer = s.customers[i.customerId];
        if (customer?.accountId !== i.accountId) return fail("not_found", "no such customer");
        if (customer.currency !== null && customer.currency !== i.currency) {
          fail("invalid_request", "the customer's currency is fixed");
        }
        if (liveSubs(s, i.customerId).length > 0) fail("invalid_request", "the customer already has a subscription");
        const amount = i.plan === "supporter" ? (i.supporterAmountMinor ?? 0) : unitPrices(i.currency).plus;
        if (amount <= 0) fail("invalid_request", "a Supporter amount is required");
        const id = nextId(s, "cs");
        s.checkouts[id] = {
          id,
          accountId: i.accountId,
          customerId: i.customerId,
          currency: i.currency,
          plan: i.plan,
          planAmountMinor: amount,
          storageBlocks: wholeQuantity(i.storageBlocks, "storageBlocks") ?? 0,
          extraMailboxes: wholeQuantity(i.extraMailboxes, "extraMailboxes") ?? 0,
          status: "open",
          createdAt: nowOf(s),
        };
        s.applied[key] = id;
        return { url: checkoutUrl(id) };
      }),

    createPortalSession: ({ customerId }) =>
      store.update((s) => {
        if (!s.customers[customerId]) fail("not_found", "no such customer");
        return { url: `${appUrl}/dev/billing/portal/${encodeURIComponent(customerId)}` };
      }),

    getSubscription: async (customerId) => {
      const s = await store.read();
      const subs = liveSubs(s, customerId);
      if (subs.length > 1) fail("multiple_subscriptions", "more than one live subscription");
      const sub = subs[0];
      return sub ? toProvider(s, sub) : null;
    },

    previewChange: async (c) => {
      const s = await store.read();
      const sub = subById(s, c.subscriptionId);
      if (!isLiveSubStatus(sub.status)) fail("invalid_request", "the subscription has ended");
      const draft = structuredClone(sub);
      return { amountDueNowMinor: applyChange(s, draft, c), currency: sub.currency };
    },

    changeSubscription: (c) =>
      store.update((s) => {
        const sub = subById(s, c.subscriptionId);
        const key = `change:${c.intentId}`;
        if (s.applied[key]) return toProvider(s, sub);
        if (!isLiveSubStatus(sub.status)) fail("invalid_request", "the subscription has ended");
        const draft = structuredClone(sub);
        const due = applyChange(s, draft, c);
        if (due > 0 && (s.customers[sub.customerId]?.cardFails ?? false)) fail("card_declined", "card declined");
        Object.assign(sub, draft);
        if (due > 0) invoice(s, sub, due, "other");
        emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
        s.applied[key] = sub.id;
        return toProvider(s, sub);
      }),

    cancel: ({ subscriptionId, when, intentId, voidOpenInvoices }) =>
      store.update((s) => {
        const sub = subById(s, subscriptionId);
        if (!isLiveSubStatus(sub.status)) return;
        if (when === "now") {
          if (voidOpenInvoices === true) {
            for (const inv of Object.values(s.invoices)) {
              if (inv.subscriptionId === sub.id && inv.status === "open") inv.status = "void";
            }
          }
          sub.status = "canceled";
          emit(s, "customer.subscription.deleted", "subscription", sub.id, sub.customerId);
          return;
        }
        // Like the processor's idempotency keys: a replayed key answers as before and changes nothing, even when the
        // subscription was changed since (e.g. the cancellation undone in the portal).
        const key = `cancel:${intentId}`;
        if (s.applied[key]) return;
        s.applied[key] = sub.id;
        if (!sub.cancelAtPeriodEnd) {
          sub.cancelAtPeriodEnd = true;
          emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
        }
      }),

    undoCancel: ({ subscriptionId, intentId }) =>
      store.update((s) => {
        const sub = subById(s, subscriptionId);
        if (!isLiveSubStatus(sub.status)) fail("invalid_request", "the subscription has ended");
        const key = `undo-cancel:${intentId}`;
        if (s.applied[key]) return;
        s.applied[key] = sub.id;
        if (sub.cancelAtPeriodEnd) {
          sub.cancelAtPeriodEnd = false;
          emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
        }
      }),

    refundInvoice: ({ invoiceId, intentId }) =>
      store.update((s) => {
        const inv = s.invoices[invoiceId];
        if (!inv) return fail("not_found", "no such invoice");
        const key = `refund:${intentId}`;
        if (s.applied[key]) return { amountMinor: inv.refundedMinor, currency: inv.currency };
        if (inv.status !== "paid" || inv.refundedMinor > 0) fail("invalid_request", "nothing to refund");
        inv.refundedMinor = inv.amountMinor;
        s.applied[key] = inv.id;
        emit(s, "charge.refunded", "charge", inv.chargeId, inv.customerId, inv);
        return { amountMinor: inv.amountMinor, currency: inv.currency };
      }),

    verifyWebhook: (rawBody, header, now): ProviderEvent =>
      verifyWebhookBody(rawBody, header, [webhookSecret], now, false),

    checkCatalogue: async (): Promise<readonly CatalogueDrift[]> => [],

    getDispute: async (disputeId) => {
      const s = await store.read();
      const inv = Object.values(s.invoices).find((i) => i.dispute?.id === disputeId);
      if (!inv?.dispute) return fail("not_found", "no such dispute");
      return {
        id: inv.dispute.id,
        status: inv.dispute.status,
        customerId: inv.customerId,
        paymentIntentId: inv.paymentIntentId,
      };
    }, // the fake's catalogue is plans.ts itself

    // ---- fake-only controls ----

    now: async () => new Date(nowOf(await store.read())),

    describe: async (kind, id) => {
      const s = await store.read();
      const cs = kind === "checkout" ? s.checkouts[id] : undefined;
      const customerId = kind === "checkout" ? cs?.customerId : id;
      const customer = customerId === undefined ? undefined : s.customers[customerId];
      if (!customer || (kind === "checkout" && !cs)) return null;
      const subs = Object.values(s.subscriptions).filter((x) => x.customerId === customer.id);
      const sub = subs.find((x) => isLiveSubStatus(x.status)) ?? subs.at(-1);
      const inv = sub?.latestInvoiceId ? s.invoices[sub.latestInvoiceId] : undefined;
      return {
        accountId: customer.accountId,
        customerId: customer.id,
        now: new Date(nowOf(s)),
        cardFails: customer.cardFails,
        checkout: cs
          ? {
              id: cs.id,
              plan: cs.plan,
              currency: cs.currency,
              totalMinor: yearAmount(cs),
              storageBlocks: cs.storageBlocks,
              extraMailboxes: cs.extraMailboxes,
              open: cs.status === "open" && nowOf(s) <= cs.createdAt + CHECKOUT_TTL_MS,
            }
          : null,
        subscription: sub
          ? {
              id: sub.id,
              status: sub.status,
              plan: sub.plan,
              currency: sub.currency,
              yearMinor: yearAmount(sub),
              periodEnd: new Date(sub.periodEnd),
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              latestInvoice: inv
                ? { status: inv.status, amountMinor: inv.amountMinor, refundedMinor: inv.refundedMinor }
                : null,
              dispute: inv?.dispute?.status ?? null,
            }
          : null,
      };
    },

    completeCheckout: (sessionId, outcome) =>
      store.update((s) => {
        const cs = s.checkouts[sessionId];
        if (!cs) return fail("not_found", "no such checkout session");
        if (cs.status !== "open" || nowOf(s) > cs.createdAt + CHECKOUT_TTL_MS) {
          fail("invalid_request", "the checkout session is no longer open");
        }
        if (outcome === "decline") return [];
        const before = s.outbox.length;
        cs.status = "complete";
        const customer = s.customers[cs.customerId];
        if (customer) customer.currency = cs.currency;
        const start = nowOf(s);
        const sub: FakeSubscription = {
          id: nextId(s, "sub"),
          customerId: cs.customerId,
          accountId: cs.accountId,
          status: "active",
          plan: cs.plan,
          currency: cs.currency,
          planAmountMinor: cs.planAmountMinor,
          storageBlocks: cs.storageBlocks,
          extraMailboxes: cs.extraMailboxes,
          periodStart: start,
          periodEnd: start + PERIOD_MS,
          cancelAtPeriodEnd: false,
          latestInvoiceId: null,
        };
        s.subscriptions[sub.id] = sub;
        emit(s, "checkout.session.completed", "checkout.session", cs.id, cs.customerId);
        emit(s, "customer.subscription.created", "subscription", sub.id, sub.customerId);
        const first = invoice(s, sub, yearAmount(sub), "subscription_create");
        if (first.status !== "paid") sub.status = "incomplete";
        return s.outbox.slice(before);
      }),

    setCardFails: (customerId, fails) =>
      store.update((s) => {
        const c = s.customers[customerId];
        if (!c) fail("not_found", "no such customer");
        else c.cardFails = fails;
      }),

    advanceClock: (days) =>
      store.update((s) => {
        if (!Number.isFinite(days) || days <= 0) fail("invalid_request", "advance by a positive number of days");
        const before = s.outbox.length;
        s.offsetMs += Math.round(days * DAY_MS);
        for (const sub of Object.values(s.subscriptions)) {
          while (isLiveSubStatus(sub.status) && sub.status !== "incomplete" && sub.periodEnd <= nowOf(s)) {
            if (sub.cancelAtPeriodEnd) {
              sub.status = "canceled";
              emit(s, "customer.subscription.deleted", "subscription", sub.id, sub.customerId);
              break;
            }
            if (sub.status !== "active" && sub.status !== "trialing") break; // unpaid/past_due/paused don't renew
            sub.periodStart = sub.periodEnd;
            sub.periodEnd += PERIOD_MS;
            const inv = invoice(s, sub, yearAmount(sub), "subscription_cycle");
            if (inv.status !== "paid") sub.status = "past_due";
            emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
          }
        }
        return s.outbox.slice(before);
      }),

    renewNow: (customerId) =>
      store.update((s) => {
        const sub = liveSub(s, customerId);
        if (sub.status !== "active") fail("invalid_request", "only an active subscription renews");
        if (sub.cancelAtPeriodEnd) fail("invalid_request", "the subscription ends at the period's end");
        const before = s.outbox.length;
        sub.periodStart = nowOf(s);
        sub.periodEnd = sub.periodStart + PERIOD_MS;
        const inv = invoice(s, sub, yearAmount(sub), "subscription_cycle");
        if (inv.status !== "paid") sub.status = "past_due";
        emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
        return s.outbox.slice(before);
      }),

    exhaustRetries: (customerId) =>
      store.update((s) => {
        const sub = liveSub(s, customerId);
        if (sub.status !== "past_due") fail("invalid_request", "the subscription isn't past due");
        const before = s.outbox.length;
        sub.status = "unpaid";
        emit(s, "customer.subscription.updated", "subscription", sub.id, sub.customerId);
        return s.outbox.slice(before);
      }),

    payOpenInvoice: (customerId) =>
      store.update((s) => {
        const sub = liveSub(s, customerId);
        const inv = latestInvoice(s, customerId);
        if (inv.status !== "open") fail("invalid_request", "no open invoice");
        const before = s.outbox.length;
        inv.status = "paid";
        inv.paidAt = nowOf(s);
        sub.status = "active";
        emit(s, "invoice.paid", "invoice", inv.id, customerId);
        emit(s, "customer.subscription.updated", "subscription", sub.id, customerId);
        return s.outbox.slice(before);
      }),

    pause: (customerId) =>
      store.update((s) => {
        const sub = liveSub(s, customerId);
        const before = s.outbox.length;
        sub.status = "paused";
        emit(s, "customer.subscription.paused", "subscription", sub.id, customerId);
        return s.outbox.slice(before);
      }),

    openDispute: (customerId) =>
      store.update((s) => {
        const inv = latestInvoice(s, customerId);
        if (inv.status !== "paid") fail("invalid_request", "only a paid invoice can be disputed");
        const before = s.outbox.length;
        inv.dispute = { id: nextId(s, "dp"), status: "open" };
        emit(s, "charge.dispute.created", "dispute", inv.dispute.id, customerId, inv);
        return s.outbox.slice(before);
      }),

    closeDispute: (customerId, outcome) =>
      store.update((s) => {
        const inv = latestInvoice(s, customerId);
        if (inv.dispute?.status !== "open") return fail("invalid_request", "no open dispute");
        const before = s.outbox.length;
        inv.dispute.status = outcome;
        emit(s, "charge.dispute.closed", "dispute", inv.dispute.id, customerId, inv);
        return s.outbox.slice(before);
      }),

    refundLatest: (customerId) =>
      store.update((s) => {
        const inv = latestInvoice(s, customerId);
        if (inv.status !== "paid" || inv.refundedMinor > 0) fail("invalid_request", "nothing to refund");
        const before = s.outbox.length;
        inv.refundedMinor = inv.amountMinor;
        emit(s, "charge.refunded", "charge", inv.chargeId, customerId, inv);
        return s.outbox.slice(before);
      }),

    drainDeliveries: () =>
      store.update((s) => {
        // Signed at delivery time on the real clock, like the processor's deliveries (`t` is when it signed, not when
        // the event happened): events made after "advance clock" carry a future `created` but still verify.
        const t = Math.floor(clock().getTime() / 1000);
        const out = s.outbox.map((e) => {
          const body = eventBody(e);
          return { body, signature: signatureHeader(webhookSecret, t, body) };
        });
        s.outbox = [];
        return out;
      }),

    sign: (body, at) => signatureHeader(webhookSecret, Math.floor(at.getTime() / 1000), body),
  };
  return provider;
}

/**
 * An event body in the processor's shape, just the fields our parser reads. A dispute object names its charge and
 * payment intent and carries no customer and no metadata of ours, like the real one (ADR-0029 §4, update 2026-11-04);
 * a charge carries its customer and payment intent.
 */
/** The provider is the fake (dev and tests): only then do the dev pages and the simulate route have anything to drive. */

export const isFakeBillingProvider = (p: BillingProvider | null | undefined): p is FakeBillingProvider =>
  p?.kind === "fake" && typeof (p as Partial<FakeBillingControls>).completeCheckout === "function";

export function eventBody(e: FakeEvent): string {
  const object =
    e.objectKind === "dispute"
      ? { id: e.objectId, object: "dispute", charge: e.chargeId ?? null, payment_intent: e.paymentIntentId ?? null }
      : {
          id: e.objectId,
          object: e.objectKind,
          customer: e.customerId,
          ...(e.paymentIntentId === undefined ? {} : { payment_intent: e.paymentIntentId }),
          metadata: e.accountId === "" ? {} : { account_id: e.accountId },
        };
  return JSON.stringify({
    id: e.id,
    object: "event",
    type: e.type,
    created: e.created,
    livemode: false,
    data: { object },
  });
}
