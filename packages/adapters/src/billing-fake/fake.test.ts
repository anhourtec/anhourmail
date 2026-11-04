// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type AccountBilling, BillingProviderError, defaultBilling, deriveBilling } from "@anhourmail/core/billing";

import { describeBillingProviderContract } from "../contract/billing-provider.contract";

import { createFakeBillingProvider, eventBody, fakeWebhookSecret, memoryFakeBillingStore } from ".";

const SECRET = fakeWebhookSecret("dev-only-seed-for-tests");
const T0 = new Date("2026-11-04T12:00:00Z");

const make = (clock: () => Date = () => T0) =>
  createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: "http://localhost:43200/",
    webhookSecret: SECRET,
    clock,
    nodeEnv: "test",
  });

const sessionOf = (url: string) => decodeURIComponent(url.split("/").pop() ?? "");

describeBillingProviderContract("fake", async () => {
  const provider = make();
  return {
    provider,
    pay: async (url) => {
      await provider.completeCheckout(sessionOf(url), "pay");
    },
    sign: (body, at) => provider.sign(body, at),
    now: () => provider.now(),
    livemode: false,
    disputes: {
      open: async (customerId) => {
        const [e] = await provider.openDispute(customerId);
        return e?.objectId ?? "";
      },
      close: async (customerId, outcome) => {
        await provider.closeDispute(customerId, outcome);
      },
    },
    cleanup: async () => undefined,
  };
});

async function customer(p: ReturnType<typeof make>, over: { storageBlocks?: number } = {}) {
  const accountId = randomUUID();
  const { customerId } = await p.ensureCustomer({ accountId, email: "x@example.test", name: "X" });
  const { url } = await p.createCheckout({
    accountId,
    customerId,
    currency: "CAD",
    plan: "plus",
    storageBlocks: over.storageBlocks ?? 0,
    extraMailboxes: 1,
    successUrl: "http://localhost/s",
    cancelUrl: "http://localhost/c",
    intentId: randomUUID(),
  });
  return { accountId, customerId, session: sessionOf(url), url };
}

describe("fake billing provider", () => {
  it("refuses to exist in production (ADR-0029 §3, layer 1)", () => {
    expect(() =>
      createFakeBillingProvider({
        store: memoryFakeBillingStore(),
        appUrl: "https://app.example.test",
        webhookSecret: SECRET,
        nodeEnv: "production",
      }),
    ).toThrow(/development and tests only/);
  });

  it("the derived webhook secret is stable per seed and differs between seeds", () => {
    expect(fakeWebhookSecret("a")).toBe(fakeWebhookSecret("a"));
    expect(fakeWebhookSecret("a")).not.toBe(fakeWebhookSecret("b"));
    expect(fakeWebhookSecret("a")).toMatch(/^whsec_dev_[0-9a-f]{64}$/);
  });

  it("checkout and portal are our own dev pages; first invoice = plan plus add-ons in the customer's currency", async () => {
    const p = make();
    const c = await customer(p, { storageBlocks: 2 });
    expect(c.url).toBe(`http://localhost:43200/dev/billing/checkout/${c.session}`);
    expect((await p.createPortalSession({ customerId: c.customerId, returnUrl: "x" })).url).toBe(
      `http://localhost:43200/dev/billing/portal/${c.customerId}`,
    );
    const events = await p.completeCheckout(c.session, "pay");
    expect(events.map((e) => e.type)).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
      "invoice.paid",
    ]);
    const sub = await p.getSubscription(c.customerId);
    expect(sub?.latestInvoice?.amountMinor).toBe(1200 + 2 * 1400 + 140);
    await expect(p.completeCheckout(c.session, "pay")).rejects.toThrow(/no longer open/);
  });

  it("a declined checkout creates nothing; an expired session can't be paid", async () => {
    let now = T0;
    const p = make(() => now);
    const c = await customer(p);
    expect(await p.completeCheckout(c.session, "decline")).toEqual([]);
    expect(await p.getSubscription(c.customerId)).toBeNull();
    now = new Date(T0.getTime() + 3_600_001);
    await expect(p.completeCheckout(c.session, "pay")).rejects.toThrow(BillingProviderError);
  });

  it("refuses a second checkout while subscribed, another currency, and another account's customer", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    const base = {
      accountId: c.accountId,
      customerId: c.customerId,
      plan: "plus" as const,
      storageBlocks: 0,
      extraMailboxes: 0,
      successUrl: "s",
      cancelUrl: "c",
    };
    await expect(p.createCheckout({ ...base, currency: "CAD", intentId: randomUUID() })).rejects.toThrow(
      /already has a subscription/,
    );
    await expect(p.createCheckout({ ...base, currency: "USD", intentId: randomUUID() })).rejects.toThrow(
      /currency is fixed/,
    );
    await expect(
      p.createCheckout({ ...base, accountId: randomUUID(), currency: "CAD", intentId: randomUUID() }),
    ).rejects.toThrow(/no such customer/);
    await expect(
      p.createCheckout({ ...base, plan: "supporter", currency: "CAD", intentId: randomUUID() }),
    ).rejects.toThrow(BillingProviderError);
  });

  it("drives the whole lifecycle through deriveBilling: renewal fails, retries run out, paid, cancelled, lapsed", async () => {
    let now = T0;
    const p = make(() => now);
    const c = await customer(p);
    let row: AccountBilling = { ...defaultBilling(c.accountId, "free", T0), providerCustomerId: c.customerId };
    const sync = async (holdCount = 1) => {
      now = await p.now();
      row = deriveBilling(row, await p.getSubscription(c.customerId), [], { now, holdCount }).next;
      return row.state;
    };
    await p.completeCheckout(c.session, "pay");
    expect(await sync()).toBe("active");
    await p.setCardFails(c.customerId, true);
    const renewal = await p.advanceClock(366);
    expect(renewal.map((e) => e.type)).toEqual(["invoice.payment_failed", "customer.subscription.updated"]);
    expect(await sync()).toBe("past_due");
    await p.exhaustRetries(c.customerId);
    expect(await sync()).toBe("restricted");
    await p.setCardFails(c.customerId, false);
    await p.payOpenInvoice(c.customerId);
    expect(await sync()).toBe("active");
    await p.cancel({ subscriptionId: row.providerSubscriptionId ?? "", when: "period_end", intentId: "i1" });
    expect(await sync()).toBe("active");
    expect(row.cancelAt).not.toBeNull();
    const ended = await p.advanceClock(400);
    expect(ended.map((e) => e.type)).toEqual(["customer.subscription.deleted"]);
    expect(await sync(2)).toBe("lapsed");
  });

  it("disputes, pauses and dashboard refunds", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    expect((await p.openDispute(c.customerId)).map((e) => e.type)).toEqual(["charge.dispute.created"]);
    expect((await p.getSubscription(c.customerId))?.disputed).toBe(true);
    expect((await p.closeDispute(c.customerId, "won")).map((e) => e.type)).toEqual(["charge.dispute.closed"]);
    expect((await p.getSubscription(c.customerId))?.disputed).toBe(false);
    await expect(p.closeDispute(c.customerId, "lost")).rejects.toThrow(/no open dispute/);
    await p.openDispute(c.customerId);
    await p.closeDispute(c.customerId, "warning_closed");
    expect(await p.getSubscription(c.customerId)).toMatchObject({ disputed: false, disputeLost: false });
    expect((await p.refundLatest(c.customerId)).map((e) => e.type)).toEqual(["charge.refunded"]);
    await expect(p.refundLatest(c.customerId)).rejects.toThrow(/nothing to refund/);
    expect((await p.pause(c.customerId)).map((e) => e.type)).toEqual(["customer.subscription.paused"]);
    expect((await p.getSubscription(c.customerId))?.status).toBe("paused");
  });

  it("charging an increase with a failing card is declined and changes nothing; a change is idempotent", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    const sub = await p.getSubscription(c.customerId);
    const subscriptionId = sub?.subscriptionId ?? "";
    await p.setCardFails(c.customerId, true);
    await expect(
      p.changeSubscription({ subscriptionId, intentId: "a", storageBlocks: 3, proration: "charge_now" }),
    ).rejects.toThrow(/declined/);
    expect((await p.getSubscription(c.customerId))?.storageBlocks).toBe(0);
    await p.setCardFails(c.customerId, false);
    const once = await p.changeSubscription({
      subscriptionId,
      intentId: "b",
      storageBlocks: 1,
      proration: "charge_now",
    });
    expect(once.latestInvoice?.billingReason).toBe("other");
    const twice = await p.changeSubscription({
      subscriptionId,
      intentId: "b",
      storageBlocks: 2,
      proration: "charge_now",
    });
    expect(twice.storageBlocks).toBe(1);
    await expect(
      p.changeSubscription({ subscriptionId, intentId: "c", storageBlocks: -1, proration: "none" }),
    ).rejects.toThrow(/whole number/);
    await expect(
      p.changeSubscription({ subscriptionId, intentId: "d", plan: "supporter", proration: "none" }),
    ).rejects.toThrow(/Supporter amount/);
    const back = await p.changeSubscription({ subscriptionId, intentId: "e", plan: "plus", proration: "none" });
    expect(back.planAmountMinor).toBe(1200);
  });

  it("a refund is applied once per intent", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    const invoiceId = (await p.getSubscription(c.customerId))?.latestInvoice?.id ?? "";
    const first = await p.refundInvoice({ invoiceId, intentId: "r" });
    expect(await p.refundInvoice({ invoiceId, intentId: "r" })).toEqual(first);
    await expect(p.refundInvoice({ invoiceId, intentId: "other" })).rejects.toThrow(/nothing to refund/);
  });

  it("an ended subscription can't be changed, undone or previewed", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    const subscriptionId = (await p.getSubscription(c.customerId))?.subscriptionId ?? "";
    await p.cancel({ subscriptionId, when: "now", intentId: "x" });
    await p.cancel({ subscriptionId, when: "now", intentId: "y" }); // already ended: nothing more
    await expect(p.undoCancel({ subscriptionId, intentId: "z" })).rejects.toThrow(/ended/);
    await expect(
      p.previewChange({ subscriptionId, intentId: "p", storageBlocks: 1, proration: "charge_now" }),
    ).rejects.toThrow(/ended/);
    await expect(
      p.changeSubscription({ subscriptionId, intentId: "q", storageBlocks: 1, proration: "charge_now" }),
    ).rejects.toThrow(/ended/);
  });

  it("delivers signed events that its own verifier accepts, oldest first, once", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    const deliveries = await p.drainDeliveries();
    expect(deliveries).toHaveLength(3);
    const events = deliveries.map((d) => p.verifyWebhook(d.body, d.signature, T0));
    expect(events.map((e) => e.type)).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
      "invoice.paid",
    ]);
    expect(events.every((e) => e.customerId === c.customerId && e.accountIdHint === c.accountId)).toBe(true);
    expect(await p.drainDeliveries()).toEqual([]);
  });

  it("dispute events have the processor's shape: a payment reference, no customer, no account metadata", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    await p.drainDeliveries();
    const [opened] = await p.openDispute(c.customerId);
    await p.closeDispute(c.customerId, "lost");
    const deliveries = await p.drainDeliveries();
    const bodies = deliveries.map((d) => JSON.parse(d.body) as { data: { object: Record<string, unknown> } });
    for (const b of bodies) {
      expect(b.data.object).not.toHaveProperty("customer");
      expect(b.data.object).not.toHaveProperty("metadata");
      expect(b.data.object.object).toBe("dispute");
      expect(b.data.object.charge).toMatch(/^ch_fake_/);
      expect(b.data.object.payment_intent).toMatch(/^pi_fake_/);
    }
    const events = deliveries.map((d) => p.verifyWebhook(d.body, d.signature, T0));
    expect(events.map((e) => e.type)).toEqual(["charge.dispute.created", "charge.dispute.closed"]);
    const dispute = await p.getDispute(opened?.objectId ?? "");
    for (const e of events) {
      expect(e).toMatchObject({ customerId: null, accountIdHint: null, objectId: dispute.id });
      expect(e.paymentIntentId).toBe(dispute.paymentIntentId);
    }
    // Ingestion resolves the customer through the provider, never from the event.
    expect(dispute).toMatchObject({ status: "lost", customerId: c.customerId });
    expect(await p.getSubscription(c.customerId)).toMatchObject({ disputed: false, disputeLost: true });
  });

  it("a refund event is the charge, with its customer and payment intent", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    await p.drainDeliveries();
    await p.refundLatest(c.customerId);
    const [d] = await p.drainDeliveries();
    const e = p.verifyWebhook(d?.body ?? "", d?.signature ?? null, T0);
    expect(e).toMatchObject({ type: "charge.refunded", customerId: c.customerId, accountIdHint: c.accountId });
    expect(e.chargeId).toBe(e.objectId);
    expect(e.paymentIntentId).toMatch(/^pi_fake_/);
  });

  it("deliveries are signed at delivery time on the real clock, so events after advancing the clock still verify", async () => {
    const p = make();
    const c = await customer(p);
    await p.completeCheckout(c.session, "pay");
    await p.drainDeliveries();
    await p.advanceClock(366);
    const deliveries = await p.drainDeliveries();
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      const e = p.verifyWebhook(d.body, d.signature, T0);
      expect(e.createdAt.getTime()).toBeGreaterThan(T0.getTime() + 365 * 86_400_000);
    }
  });

  it("controls refuse what can't happen", async () => {
    const p = make();
    const c = await customer(p);
    await expect(p.advanceClock(0)).rejects.toThrow(/positive/);
    await expect(p.exhaustRetries(c.customerId)).rejects.toThrow(/no live subscription/);
    await expect(p.setCardFails("cus_missing", true)).rejects.toThrow(/no such customer/);
    await expect(p.createPortalSession({ customerId: "cus_missing", returnUrl: "x" })).rejects.toThrow(
      /no such customer/,
    );
    await expect(p.completeCheckout("cs_missing", "pay")).rejects.toThrow(/no such checkout/);
    await p.completeCheckout(c.session, "pay");
    await expect(p.exhaustRetries(c.customerId)).rejects.toThrow(/isn't past due/);
    await expect(p.payOpenInvoice(c.customerId)).rejects.toThrow(/no open invoice/);
    expect(await p.checkCatalogue()).toEqual([]);
  });

  it("an event for an unknown customer carries no account hint", () => {
    const body = eventBody({
      id: "evt_1",
      type: "customer.deleted",
      created: 1,
      objectId: "cus_1",
      objectKind: "customer",
      customerId: "cus_1",
      accountId: "",
    });
    expect(JSON.parse(body)).toMatchObject({ data: { object: { metadata: {} } } });
  });
});
