// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contract every `BillingProvider` adapter passes (ADR-0029 §1, §10): the fake in every unit run; the payment
 * processor's test mode only in the manual live suite (`npm run test:billing-live`, never CI). A harness drives what
 * only a paying person can do (completing a checkout) and signs webhook bodies the way the provider does.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type BillingProvider, type BillingProviderError, WebhookRejected } from "@anhourmail/core/billing";
import { PLANS } from "@anhourmail/shared/plans";

export type BillingProviderHarness = {
  provider: BillingProvider;
  /** Completes the checkout behind this URL as a paying customer (the session's line items decide what is bought). */
  pay(checkoutUrl: string): Promise<void>;
  /** A signature header for `body` at `at`, as the provider would send it. */
  sign(body: string, at: Date): string;
  /** The provider's clock (a test clock or the fake's offset). */
  now(): Promise<Date>;
  livemode: boolean;
  /**
   * Opens and closes a dispute on the customer's latest payment, where the provider can (the fake; the processor's
   * test mode through its dispute test card and evidence). Absent: the dispute cases are skipped.
   */
  disputes?: {
    open(customerId: string): Promise<string>;
    close(customerId: string, outcome: "won" | "lost" | "warning_closed"): Promise<void>;
  };
  cleanup(): Promise<void>;
};

const urls = (accountId: string) => ({
  successUrl: `https://app.example.test/accounts/${accountId}/billing?checkout=done`,
  cancelUrl: `https://app.example.test/accounts/${accountId}/billing?checkout=cancelled`,
});

async function subscribe(
  h: BillingProviderHarness,
  over: { plan?: "plus" | "supporter"; supporterAmountMinor?: number; storageBlocks?: number } = {},
) {
  const accountId = randomUUID();
  const { customerId } = await h.provider.ensureCustomer({ accountId, email: "payer@example.test", name: "Payer" });
  const { url } = await h.provider.createCheckout({
    accountId,
    customerId,
    currency: "USD",
    plan: over.plan ?? "plus",
    ...(over.supporterAmountMinor === undefined ? {} : { supporterAmountMinor: over.supporterAmountMinor }),
    storageBlocks: over.storageBlocks ?? 0,
    extraMailboxes: 0,
    ...urls(accountId),
    intentId: randomUUID(),
  });
  await h.pay(url);
  const sub = await h.provider.getSubscription(customerId);
  if (!sub) throw new Error("no subscription after paying");
  return { accountId, customerId, sub };
}

async function withHarness(
  factory: () => Promise<BillingProviderHarness>,
  fn: (h: BillingProviderHarness) => Promise<void>,
): Promise<void> {
  const h = await factory();
  try {
    await fn(h);
  } finally {
    await h.cleanup();
  }
}

const providerError = (code: string) => expect.objectContaining({ code }) as BillingProviderError;

export function describeBillingProviderContract(name: string, factory: () => Promise<BillingProviderHarness>): void {
  describe(`${name} billing provider contract`, () => {
    it("ensureCustomer gives one customer per account; a new customer has no subscription", () =>
      withHarness(factory, async (h) => {
        const accountId = randomUUID();
        const a = await h.provider.ensureCustomer({ accountId, email: "a@example.test", name: "A" });
        const again = await h.provider.ensureCustomer({ accountId, email: "a@example.test", name: "A" });
        const other = await h.provider.ensureCustomer({ accountId: randomUUID(), email: "b@example.test", name: "B" });
        expect(again.customerId).toBe(a.customerId);
        expect(other.customerId).not.toBe(a.customerId);
        expect(await h.provider.getSubscription(a.customerId)).toBeNull();
      }));

    it("checkout: a URL; the same intent gives the same session", () =>
      withHarness(factory, async (h) => {
        const accountId = randomUUID();
        const { customerId } = await h.provider.ensureCustomer({ accountId, email: "c@example.test", name: "C" });
        const input = {
          accountId,
          customerId,
          currency: "USD" as const,
          plan: "plus" as const,
          storageBlocks: 0,
          extraMailboxes: 0,
          ...urls(accountId),
          intentId: randomUUID(),
        };
        const first = await h.provider.createCheckout(input);
        expect(() => new URL(first.url)).not.toThrow();
        expect((await h.provider.createCheckout(input)).url).toBe(first.url);
      }));

    it("paying a Plus checkout gives an active yearly subscription with its first invoice paid", () =>
      withHarness(factory, async (h) => {
        const { customerId, sub } = await subscribe(h, { storageBlocks: 2 });
        expect(sub).toMatchObject({
          customerId,
          status: "active",
          plan: "plus",
          currency: "USD",
          planAmountMinor: PLANS.plus.price?.USD,
          storageBlocks: 2,
          extraMailboxes: 0,
          cancelAt: null,
          disputed: false,
        });
        const days = (sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()) / 86_400_000;
        expect(days).toBeGreaterThanOrEqual(365);
        expect(days).toBeLessThanOrEqual(366);
        expect(sub.latestInvoice).toMatchObject({
          status: "paid",
          billingReason: "subscription_create",
          refundedMinor: 0,
        });
        expect(sub.latestInvoice?.paidAt).toBeInstanceOf(Date);
      }));

    it("a Supporter checkout carries the chosen amount", () =>
      withHarness(factory, async (h) => {
        const { sub } = await subscribe(h, { plan: "supporter", supporterAmountMinor: 5000 });
        expect(sub).toMatchObject({ plan: "supporter", planAmountMinor: 5000 });
      }));

    it("an add-on increase is previewed and charged now; a decrease costs nothing now", () =>
      withHarness(factory, async (h) => {
        const { sub } = await subscribe(h);
        const up = { subscriptionId: sub.subscriptionId, storageBlocks: 1, proration: "charge_now" as const };
        const preview = await h.provider.previewChange({ ...up, intentId: randomUUID() });
        expect(preview.currency).toBe("USD");
        expect(preview.amountDueNowMinor).toBeGreaterThan(0);
        expect(preview.amountDueNowMinor).toBeLessThanOrEqual(PLANS.plus.storageBlockPrice?.USD ?? 0);
        const raised = await h.provider.changeSubscription({ ...up, intentId: randomUUID() });
        expect(raised.storageBlocks).toBe(1);
        const down = { subscriptionId: sub.subscriptionId, storageBlocks: 0, proration: "none" as const };
        expect((await h.provider.previewChange({ ...down, intentId: randomUUID() })).amountDueNowMinor).toBe(0);
        expect((await h.provider.changeSubscription({ ...down, intentId: randomUUID() })).storageBlocks).toBe(0);
      }));

    it("Plus → Supporter switches the plan and its amount", () =>
      withHarness(factory, async (h) => {
        const { sub } = await subscribe(h);
        const changed = await h.provider.changeSubscription({
          subscriptionId: sub.subscriptionId,
          intentId: randomUUID(),
          plan: "supporter",
          supporterAmountMinor: 3000,
          proration: "none",
        });
        expect(changed).toMatchObject({ plan: "supporter", planAmountMinor: 3000 });
      }));

    it("cancel at period end sets cancelAt; undo clears it; cancel now ends it", () =>
      withHarness(factory, async (h) => {
        const { customerId, sub } = await subscribe(h);
        await h.provider.cancel({ subscriptionId: sub.subscriptionId, when: "period_end", intentId: randomUUID() });
        expect((await h.provider.getSubscription(customerId))?.cancelAt).toEqual(sub.currentPeriodEnd);
        await h.provider.undoCancel({ subscriptionId: sub.subscriptionId, intentId: randomUUID() });
        expect((await h.provider.getSubscription(customerId))?.cancelAt).toBeNull();
        await h.provider.cancel({ subscriptionId: sub.subscriptionId, when: "now", intentId: randomUUID() });
        expect(await h.provider.getSubscription(customerId)).toBeNull();
      }));

    it("refunding the first invoice returns its amount and shows it refunded", () =>
      withHarness(factory, async (h) => {
        const { customerId, sub } = await subscribe(h);
        const invoiceId = sub.latestInvoice?.id ?? "";
        const refund = await h.provider.refundInvoice({ invoiceId, intentId: randomUUID() });
        expect(refund).toEqual({ amountMinor: sub.latestInvoice?.amountMinor, currency: "USD" });
        expect((await h.provider.getSubscription(customerId))?.latestInvoice?.refundedMinor).toBe(refund.amountMinor);
      }));

    it("unknown subscriptions and invoices are not_found", () =>
      withHarness(factory, async (h) => {
        await expect(
          h.provider.cancel({ subscriptionId: "sub_missing", when: "now", intentId: randomUUID() }),
        ).rejects.toThrow(providerError("not_found"));
        await expect(h.provider.refundInvoice({ invoiceId: "in_missing", intentId: randomUUID() })).rejects.toThrow(
          providerError("not_found"),
        );
      }));

    it("webhooks: a signed body verifies; a tampered one and a stale one don't", () =>
      withHarness(factory, async (h) => {
        const now = await h.now();
        const accountId = randomUUID();
        const body = JSON.stringify({
          id: `evt_${randomUUID()}`,
          object: "event",
          type: "invoice.paid",
          created: Math.floor(now.getTime() / 1000),
          livemode: h.livemode,
          data: { object: { id: "in_x", object: "invoice", customer: "cus_x", metadata: { account_id: accountId } } },
        });
        const header = h.sign(body, now);
        expect(h.provider.verifyWebhook(body, header, now)).toMatchObject({
          type: "invoice.paid",
          customerId: "cus_x",
          objectId: "in_x",
          accountIdHint: accountId,
        });
        expect(() => h.provider.verifyWebhook(body.replace("in_x", "in_y"), header, now)).toThrow(WebhookRejected);
        expect(() => h.provider.verifyWebhook(body, header, new Date(now.getTime() + 301_000))).toThrow(
          WebhookRejected,
        );
        expect(() => h.provider.verifyWebhook(body, null, now)).toThrow(WebhookRejected);
      }));

    it("an unknown dispute is not_found", () =>
      withHarness(factory, async (h) => {
        await expect(h.provider.getDispute("dp_missing")).rejects.toThrow(providerError("not_found"));
      }));

    it("a dispute resolves to its customer; lost keeps it counted, won clears it", () =>
      withHarness(factory, async (h) => {
        if (!h.disputes) return; // this provider can't open disputes on demand
        for (const outcome of ["lost", "won"] as const) {
          const { customerId } = await subscribe(h);
          const disputeId = await h.disputes.open(customerId);
          expect(await h.provider.getDispute(disputeId)).toMatchObject({ id: disputeId, status: "open", customerId });
          expect(await h.provider.getSubscription(customerId)).toMatchObject({ disputed: true, disputeLost: false });
          await h.disputes.close(customerId, outcome);
          expect((await h.provider.getDispute(disputeId)).status).toBe(outcome);
          expect(await h.provider.getSubscription(customerId)).toMatchObject({
            disputed: false,
            disputeLost: outcome === "lost",
          });
        }
      }));

    it("the catalogue check answers a list (empty = in sync)", () =>
      withHarness(factory, async (h) => {
        expect(Array.isArray(await h.provider.checkCatalogue())).toBe(true);
      }));
  });
}
