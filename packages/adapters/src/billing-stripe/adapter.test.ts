// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type BillingProviderError, WebhookRejected } from "@anhourmail/core/billing";
import { setLogSinkForTests } from "@anhourmail/server/log";

import { createStripeBillingProvider, idempotencyKey } from "./adapter";
import type { StripeConfig } from "./config";
import { signatureHeader } from "./signature";
import { type Recorded, stubFetch } from "./stub-fetch";

const NOW = new Date("2026-11-04T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const YEAR_S = 365 * 86_400;
const ACCOUNT = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const config: StripeConfig = {
  secretKey: "rk_test_0000example",
  mode: "test",
  webhookSecrets: ["whsec_old", "whsec_new"],
  prices: { plus: ["price_plus", "price_plusLegacy"], storageBlock: ["price_storage"], extraMailbox: ["price_extra"] },
  supporterProduct: "prod_supporter",
  portalConfiguration: "bpc_1",
};

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

const price = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  product: "prod_plus",
  currency: "usd",
  unit_amount: 900,
  ...over,
});
const item = (id: string, p: ReturnType<typeof price>, quantity = 1) => ({
  id,
  quantity,
  current_period_start: NOW_S,
  current_period_end: NOW_S + YEAR_S,
  price: p,
});
const paidInvoice = {
  id: "in_1",
  status: "paid",
  total: 2300,
  amount_paid: 2300,
  billing_reason: "subscription_create",
  status_transitions: { paid_at: NOW_S },
};
const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  currency: "usd",
  cancel_at: null,
  cancel_at_period_end: false,
  items: {
    data: [
      item("si_plan", price("price_plus")),
      item("si_storage", price("price_storage", { product: "prod_storage", unit_amount: 1000 }), 1),
      item("si_extra", price("price_extra", { product: "prod_extra", unit_amount: 100 }), 4),
    ],
  },
  latest_invoice: paidInvoice,
  ...over,
});
const paymentRoutes = (refunded = 0, disputes: string[] = [], captured = 2300) => ({
  "GET /invoice_payments": {
    json: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_1" } }], has_more: false },
  },
  "GET /payment_intents/pi_1": {
    json: {
      id: "pi_1",
      latest_charge: { id: "ch_1", amount_refunded: refunded, amount_captured: captured, status: "succeeded" },
    },
  },
  "GET /disputes": {
    json: { data: disputes.map((status, i) => ({ id: `dp_${String(i)}`, status })), has_more: false },
  },
});

const provider = (routes: Parameters<typeof stubFetch>[0]) => {
  const stub = stubFetch(routes);
  const p = createStripeBillingProvider(config, {
    fetch: stub.fetch,
    sleep: async () => undefined,
    clock: () => NOW,
  });
  return { p, calls: stub.calls };
};
const code = (c: string) => expect.objectContaining({ code: c }) as BillingProviderError;
const call = (calls: Recorded[], method: string, path: string) =>
  calls.find((c) => c.method === method && c.path === path);

describe("processor adapter: reading a subscription", () => {
  it("maps plan, add-on quantities, periods, the latest invoice and its refund and dispute state", async () => {
    const { p, calls } = provider({
      "GET /subscriptions": {
        json: { data: [subscription(), subscription({ id: "sub_old", status: "canceled" })], has_more: false },
      },
      ...paymentRoutes(500, ["won", "needs_response"]),
    });
    expect(await p.getSubscription("cus_1")).toEqual({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      status: "active",
      plan: "plus",
      currency: "USD",
      planAmountMinor: 900,
      storageBlocks: 1,
      extraMailboxes: 4,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date((NOW_S + YEAR_S) * 1000),
      cancelAt: null,
      latestInvoice: {
        id: "in_1",
        status: "paid",
        amountMinor: 2300,
        paidAt: NOW,
        billingReason: "subscription_create",
        refundedMinor: 500,
        chargedMinor: 2300,
        // No lines on this invoice: the sync falls back to the subscription's quantities.
        storageBlocks: null,
        extraMailboxes: null,
        periodEnd: null,
      },
      disputed: true,
      disputeLost: false,
      // By id, so the sync can honour a staff clear of one of them.
      latestDisputes: [
        { id: "dp_0", status: "won" },
        { id: "dp_1", status: "open" },
      ],
    });
    const list = call(calls, "GET", "/subscriptions");
    expect(list?.query.get("customer")).toBe("cus_1");
    expect(list?.query.get("status")).toBe("all");
    expect(list?.query.getAll("expand[]")).toEqual(["data.latest_invoice"]);
  });

  it("counts only what a succeeded charge captured: credit-balance, out-of-band and pending payments charge nothing (F8)", async () => {
    const charged = async (routes: Parameters<typeof stubFetch>[0]) =>
      (
        await provider({
          "GET /subscriptions": { json: { data: [subscription()], has_more: false } },
          ...routes,
        }).p.getSubscription("cus_1")
      )?.latestInvoice?.chargedMinor;
    expect(await charged(paymentRoutes(0, [], 2300))).toBe(2300);
    // Paid from the credit balance or marked paid out of band: no payment intent behind the invoice.
    expect(
      await charged({ ...paymentRoutes(), "GET /invoice_payments": { json: { data: [], has_more: false } } }),
    ).toBe(0);
    // A charge that hasn't succeeded, or one that doesn't say what it captured, is not money.
    for (const latest of [
      { id: "ch_1", amount_refunded: 0, amount_captured: 2300, status: "pending" },
      { id: "ch_1", amount_refunded: 0 },
    ]) {
      expect(
        await charged({
          ...paymentRoutes(),
          "GET /payment_intents/pi_1": { json: { id: "pi_1", latest_charge: latest } },
        }),
      ).toBe(0);
    }
  });

  it("reads what the latest invoice billed from its lines, prorations left out (run-62 F1)", async () => {
    const line = (priceId: string, quantity: number, extra: Record<string, unknown> = {}) => ({
      quantity,
      period: { start: NOW_S, end: NOW_S + YEAR_S },
      pricing: { price_details: { price: priceId } },
      ...extra,
    });
    const { p } = provider({
      "GET /subscriptions": {
        json: {
          data: [
            subscription({
              latest_invoice: {
                ...paidInvoice,
                billing_reason: "subscription_cycle",
                lines: {
                  data: [
                    line("price_plus", 1),
                    line("price_storage", 0),
                    line("price_extra", 2),
                    // A proration line (new shape) and one priced the old way.
                    line("price_storage", 5, { parent: { subscription_item_details: { proration: true } } }),
                    { quantity: 1, price: { id: "price_extra" }, period: { start: NOW_S, end: NOW_S + YEAR_S } },
                  ],
                  has_more: false,
                },
              },
            }),
          ],
          has_more: false,
        },
      },
      ...paymentRoutes(),
    });
    const inv = (await p.getSubscription("cus_1"))?.latestInvoice;
    expect(inv).toMatchObject({
      billingReason: "subscription_cycle",
      storageBlocks: 0,
      extraMailboxes: 3,
      periodEnd: new Date((NOW_S + YEAR_S) * 1000),
    });
  });

  it.each([
    [["lost"], false, true],
    [["won", "warning_closed"], false, false],
    [["warning_under_review"], true, false],
    [["some_future_status"], true, false],
  ])("disputes %j → disputed %s, lost %s", async (statuses, disputed, disputeLost) => {
    const { p } = provider({
      "GET /subscriptions": { json: { data: [subscription()], has_more: false } },
      ...paymentRoutes(0, statuses),
    });
    expect(await p.getSubscription("cus_1")).toMatchObject({ disputed, disputeLost });
  });

  it("getDispute reads the outcome and finds the customer through the disputed payment", async () => {
    const { p, calls } = provider({
      "GET /disputes/dp_1": {
        json: { id: "dp_1", status: "lost", payment_intent: { id: "pi_1", customer: "cus_7" }, charge: "ch_1" },
      },
      "GET /disputes/dp_2": {
        json: {
          id: "dp_2",
          status: "needs_response",
          payment_intent: null,
          charge: { id: "ch_2", customer: { id: "cus_8" } },
        },
      },
      "GET /disputes/dp_3": { json: { id: "dp_3", status: "warning_closed", payment_intent: "pi_3", charge: "ch_3" } },
    });
    expect(await p.getDispute("dp_1")).toEqual({
      id: "dp_1",
      status: "lost",
      customerId: "cus_7",
      paymentIntentId: "pi_1",
    });
    expect(call(calls, "GET", "/disputes/dp_1")?.query.getAll("expand[]")).toEqual(["payment_intent", "charge"]);
    expect(await p.getDispute("dp_2")).toEqual({
      id: "dp_2",
      status: "open",
      customerId: "cus_8",
      paymentIntentId: null,
    });
    // Unexpanded references: no customer known (ingestion keeps the event for a later attempt).
    expect(await p.getDispute("dp_3")).toEqual({
      id: "dp_3",
      status: "warning_closed",
      customerId: null,
      paymentIntentId: "pi_3",
    });
    await expect(p.getDispute("dp_missing")).rejects.toThrow(code("not_found"));
  });

  it("a CAD subscription on a multi-currency price reads the CAD amount; a legacy price still maps", async () => {
    const { p } = provider({
      "GET /subscriptions": {
        json: {
          data: [subscription({ currency: "cad", items: { data: [item("si", price("price_plusLegacy"))] } })],
          has_more: false,
        },
      },
      "GET /prices/price_plusLegacy": {
        json: price("price_plusLegacy", { currency_options: { cad: { unit_amount: 1200 } } }),
      },
      ...paymentRoutes(),
    });
    expect(await p.getSubscription("cus_1")).toMatchObject({ currency: "CAD", planAmountMinor: 1200, disputed: false });
  });

  it("a Supporter subscription is recognised by its product (inline prices)", async () => {
    const supporter = price("price_inline", { product: "prod_supporter", unit_amount: 5000 });
    const { p } = provider({
      "GET /subscriptions": {
        json: {
          data: [
            subscription({
              cancel_at_period_end: true,
              latest_invoice: null,
              items: { data: [item("si", supporter)] },
            }),
          ],
          has_more: false,
        },
      },
    });
    expect(await p.getSubscription("cus_1")).toMatchObject({
      plan: "supporter",
      planAmountMinor: 5000,
      cancelAt: new Date((NOW_S + YEAR_S) * 1000),
      latestInvoice: null,
    });
  });

  it("an unexpanded open invoice is fetched; nothing is paid so no payment lookups", async () => {
    const { p, calls } = provider({
      "GET /subscriptions": {
        json: {
          data: [subscription({ status: "past_due", latest_invoice: "in_2", cancel_at: NOW_S })],
          has_more: false,
        },
      },
      "GET /invoices/in_2": {
        json: {
          ...paidInvoice,
          id: "in_2",
          status: "draft",
          amount_paid: 0,
          billing_reason: "subscription_update",
          status_transitions: { paid_at: null },
        },
      },
    });
    expect(await p.getSubscription("cus_1")).toMatchObject({
      status: "past_due",
      cancelAt: NOW,
      latestInvoice: { id: "in_2", status: "open", amountMinor: 2300, paidAt: null, billingReason: "other" },
    });
    expect(call(calls, "GET", "/invoice_payments")).toBeUndefined();
  });

  it("no live subscription or a deleted customer is null; two live ones refuse to guess", async () => {
    expect(
      await provider({
        "GET /subscriptions": { json: { data: [subscription({ status: "incomplete_expired" })], has_more: false } },
      }).p.getSubscription("cus_1"),
    ).toBeNull();
    expect(
      await provider({
        "GET /subscriptions": { status: 404, json: { error: { message: "No such customer" } } },
      }).p.getSubscription("cus_x"),
    ).toBeNull();
    await expect(
      provider({
        "GET /subscriptions": { json: { data: [subscription(), subscription({ id: "sub_2" })], has_more: false } },
      }).p.getSubscription("cus_1"),
    ).rejects.toThrow(code("multiple_subscriptions"));
    await expect(provider({ "GET /subscriptions": { status: 500 } }).p.getSubscription("cus_1")).rejects.toThrow(
      code("unavailable"),
    );
  });

  it.each([
    ["an unknown price", { items: { data: [item("si", price("price_unknown"))] } }],
    ["no plan item", { items: { data: [item("si", price("price_storage"))] } }],
    ["two plan items", { items: { data: [item("a", price("price_plus")), item("b", price("price_plus"))] } }],
    ["a currency we don't offer", { currency: "eur" }],
  ])("%s is catalogue drift", async (_what, over) => {
    const { p } = provider({
      "GET /subscriptions": { json: { data: [subscription(over)], has_more: false } },
      ...paymentRoutes(),
    });
    await expect(p.getSubscription("cus_1")).rejects.toThrow(code("catalogue_drift"));
  });

  it("a multi-currency price without the subscription's currency is drift", async () => {
    const { p } = provider({
      "GET /subscriptions": {
        json: { data: [subscription({ currency: "cad", latest_invoice: null })], has_more: false },
      },
      "GET /prices/price_plus": { json: price("price_plus", { currency_options: {} }) },
    });
    await expect(p.getSubscription("cus_1")).rejects.toThrow(code("catalogue_drift"));
  });
});

describe("processor adapter: writes", () => {
  it("ensureCustomer sends the account id as metadata with a deterministic idempotency key", async () => {
    const { p, calls } = provider({ "POST /customers": { json: { id: "cus_9" } } });
    expect(await p.ensureCustomer({ accountId: ACCOUNT, email: "a@example.test", name: "Ana" })).toEqual({
      customerId: "cus_9",
    });
    const req = call(calls, "POST", "/customers");
    expect(req?.body.get("metadata[account_id]")).toBe(ACCOUNT);
    expect(req?.headers.get("idempotency-key")).toBe(idempotencyKey(ACCOUNT, "customer", "create"));
  });

  it("checkout: subscription mode, tax, address and tax ids, an hour's expiry, current prices, add-ons", async () => {
    const { p, calls } = provider({
      "POST /checkout/sessions": { json: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" } },
    });
    const out = await p.createCheckout({
      accountId: ACCOUNT,
      customerId: "cus_1",
      currency: "CAD",
      plan: "plus",
      storageBlocks: 2,
      extraMailboxes: 3,
      successUrl: "https://app.example.test/ok",
      cancelUrl: "https://app.example.test/no",
      intentId: "intent-1",
    });
    expect(out.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    const b = call(calls, "POST", "/checkout/sessions")?.body;
    expect(Object.fromEntries(b ?? [])).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: ACCOUNT,
      currency: "cad",
      "line_items[0][price]": "price_plus",
      "line_items[1][price]": "price_storage",
      "line_items[1][quantity]": "2",
      "line_items[2][price]": "price_extra",
      "line_items[2][quantity]": "3",
      "subscription_data[metadata][account_id]": ACCOUNT,
      "automatic_tax[enabled]": "true",
      billing_address_collection: "required",
      "customer_update[address]": "auto",
      "tax_id_collection[enabled]": "true",
      expires_at: String(NOW_S + 3600),
    });
    expect(call(calls, "POST", "/checkout/sessions")?.headers.get("idempotency-key")).toBe(
      idempotencyKey(ACCOUNT, "checkout", "intent-1"),
    );
  });

  it("a Supporter checkout uses an inline yearly, tax-exclusive price on the Supporter product", async () => {
    const { p, calls } = provider({
      "POST /checkout/sessions": { json: { id: "cs_1", url: "https://checkout.stripe.com/x" } },
    });
    await p.createCheckout({
      accountId: ACCOUNT,
      customerId: "cus_1",
      currency: "USD",
      plan: "supporter",
      supporterAmountMinor: 4000,
      storageBlocks: 0,
      extraMailboxes: 0,
      successUrl: "s",
      cancelUrl: "c",
      intentId: "i",
    });
    expect(Object.fromEntries(call(calls, "POST", "/checkout/sessions")?.body ?? [])).toMatchObject({
      "line_items[0][price_data][product]": "prod_supporter",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "4000",
      "line_items[0][price_data][recurring][interval]": "year",
      "line_items[0][price_data][tax_behavior]": "exclusive",
    });
  });

  it("refuses a checkout or portal URL on any other origin (no open redirect)", async () => {
    const evil = provider({
      "POST /checkout/sessions": { json: { id: "cs", url: "https://checkout.stripe.com.evil.test/x" } },
      "POST /billing_portal/sessions": { json: { url: "javascript:alert(1)" } },
    });
    const input = {
      accountId: ACCOUNT,
      customerId: "cus_1",
      currency: "USD" as const,
      plan: "plus" as const,
      storageBlocks: 0,
      extraMailboxes: 0,
      successUrl: "s",
      cancelUrl: "c",
      intentId: "i",
    };
    await expect(evil.p.createCheckout(input)).rejects.toThrow(code("invalid_request"));
    await expect(evil.p.createPortalSession({ customerId: "cus_1", returnUrl: "r" })).rejects.toThrow(
      code("invalid_request"),
    );
    const good = provider({
      "POST /billing_portal/sessions": { json: { url: "https://billing.stripe.com/p/session/x" } },
    });
    expect(
      (await good.p.createPortalSession({ customerId: "cus_1", returnUrl: "https://app.example.test/b" })).url,
    ).toBe("https://billing.stripe.com/p/session/x");
    expect(good.calls[0]?.body.get("configuration")).toBe("bpc_1");
  });

  it("an increase is previewed with immediate proration and charged with error_if_incomplete", async () => {
    const { p, calls } = provider({
      "GET /subscriptions/sub_1": { json: subscription() },
      "POST /invoices/create_preview": { json: { amount_due: 731, currency: "usd" } },
      "POST /subscriptions/sub_1": { json: subscription() },
      ...paymentRoutes(),
    });
    const change = {
      subscriptionId: "sub_1",
      intentId: "c1",
      storageBlocks: 3,
      extraMailboxes: 5,
      proration: "charge_now" as const,
    };
    expect(await p.previewChange(change)).toEqual({ amountDueNowMinor: 731, currency: "USD" });
    expect(Object.fromEntries(call(calls, "POST", "/invoices/create_preview")?.body ?? [])).toMatchObject({
      subscription: "sub_1",
      "subscription_details[items][0][id]": "si_storage",
      "subscription_details[items][0][quantity]": "3",
      "subscription_details[items][1][id]": "si_extra",
      "subscription_details[items][1][quantity]": "5",
      "subscription_details[proration_behavior]": "always_invoice",
      "subscription_details[proration_date]": String(NOW_S),
    });
    await p.changeSubscription(change);
    expect(Object.fromEntries(call(calls, "POST", "/subscriptions/sub_1")?.body ?? [])).toMatchObject({
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      "expand[]": "latest_invoice",
    });
  });

  it("a decrease or plan switch costs nothing now: no preview call, no proration, items deleted at 0", async () => {
    const { p, calls } = provider({
      "GET /subscriptions/sub_1": { json: subscription({ items: { data: [item("si_plan", price("price_plus"))] } }) },
      "POST /subscriptions/sub_1": { json: subscription() },
      ...paymentRoutes(),
    });
    expect(
      await p.previewChange({ subscriptionId: "sub_1", intentId: "x", storageBlocks: 0, proration: "none" }),
    ).toEqual({
      amountDueNowMinor: 0,
      currency: "USD",
    });
    expect(call(calls, "POST", "/invoices/create_preview")).toBeUndefined();
    await p.changeSubscription({
      subscriptionId: "sub_1",
      intentId: "y",
      plan: "supporter",
      supporterAmountMinor: 3000,
      storageBlocks: 0,
      extraMailboxes: 2,
      proration: "none",
    });
    const body = Object.fromEntries(call(calls, "POST", "/subscriptions/sub_1")?.body ?? []);
    expect(body).toMatchObject({
      "items[0][id]": "si_plan",
      "items[0][price_data][product]": "prod_supporter",
      "items[0][price_data][unit_amount]": "3000",
      "items[1][price]": "price_extra",
      "items[1][quantity]": "2",
      proration_behavior: "none",
    });
    expect(body.payment_behavior).toBeUndefined();
  });

  it("Supporter → Plus uses the current Plus price; removing an add-on deletes its item; switching needs an amount", async () => {
    const supporterSub = subscription({
      items: {
        data: [
          item("si_plan", price("price_inline", { product: "prod_supporter", unit_amount: 3000 })),
          item("si_storage", price("price_storage", { product: "prod_storage" }), 2),
        ],
      },
    });
    const { p, calls } = provider({
      "GET /subscriptions/sub_1": { json: supporterSub },
      "POST /subscriptions/sub_1": { json: subscription() },
      ...paymentRoutes(),
    });
    await p.changeSubscription({
      subscriptionId: "sub_1",
      intentId: "z",
      plan: "plus",
      storageBlocks: 0,
      proration: "none",
    });
    expect(Object.fromEntries(call(calls, "POST", "/subscriptions/sub_1")?.body ?? [])).toMatchObject({
      "items[0][id]": "si_plan",
      "items[0][price]": "price_plus",
      "items[1][id]": "si_storage",
      "items[1][deleted]": "true",
    });
    const plusOnly = provider({ "GET /subscriptions/sub_1": { json: subscription() } });
    await expect(
      plusOnly.p.changeSubscription({ subscriptionId: "sub_1", intentId: "w", plan: "supporter", proration: "none" }),
    ).rejects.toThrow(code("invalid_request"));
  });

  it("a declined charge surfaces as card_declined", async () => {
    const { p } = provider({
      "GET /subscriptions/sub_1": { json: subscription() },
      "POST /subscriptions/sub_1": { status: 402, json: { error: { type: "card_error" } } },
    });
    await expect(
      p.changeSubscription({ subscriptionId: "sub_1", intentId: "d", storageBlocks: 9, proration: "charge_now" }),
    ).rejects.toThrow(code("card_declined"));
  });

  it("cancel at period end, undo, and cancel now", async () => {
    const { p, calls } = provider({
      "POST /subscriptions/sub_1": { json: { id: "sub_1" } },
      "DELETE /subscriptions/sub_1": { json: { id: "sub_1" } },
    });
    await p.cancel({ subscriptionId: "sub_1", when: "period_end", intentId: "k1" });
    await p.undoCancel({ subscriptionId: "sub_1", intentId: "k2" });
    await p.cancel({ subscriptionId: "sub_1", when: "now", intentId: "k3" });
    expect(calls.map((c) => [c.method, c.path, c.body.get("cancel_at_period_end")])).toEqual([
      ["POST", "/subscriptions/sub_1", "true"],
      ["POST", "/subscriptions/sub_1", "false"],
      ["DELETE", "/subscriptions/sub_1", null],
    ]);
  });

  it("ending now for a deletion voids the open invoices first, each with its own idempotency key", async () => {
    const { p, calls } = provider({
      "GET /invoices": { json: { data: [{ id: "in_open1" }, { id: "in_open2" }], has_more: false } },
      "POST /invoices/in_open1/void": { json: { id: "in_open1" } },
      "POST /invoices/in_open2/void": { json: { id: "in_open2" } },
      "DELETE /subscriptions/sub_1": { json: { id: "sub_1" } },
    });
    await p.cancel({ subscriptionId: "sub_1", when: "now", intentId: "del", voidOpenInvoices: true });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/invoices"],
      ["POST", "/invoices/in_open1/void"],
      ["POST", "/invoices/in_open2/void"],
      ["DELETE", "/subscriptions/sub_1"],
    ]);
    expect(calls[0]?.query.get("subscription")).toBe("sub_1");
    expect(calls[0]?.query.get("status")).toBe("open");
    expect(calls[1]?.headers.get("idempotency-key")).toBe(idempotencyKey("in_open1", "void", "del"));
  });

  it("refunds an invoice's payment in full; an invoice without a payment is not_found", async () => {
    const { p, calls } = provider({
      ...paymentRoutes(),
      "POST /refunds": { json: { amount: 2300, currency: "usd" } },
    });
    expect(await p.refundInvoice({ invoiceId: "in_1", intentId: "r1" })).toEqual({
      amountMinor: 2300,
      currency: "USD",
    });
    const req = call(calls, "POST", "/refunds");
    expect(req?.body.get("payment_intent")).toBe("pi_1");
    expect(req?.headers.get("idempotency-key")).toBe(idempotencyKey("in_1", "refund", "r1"));
    const none = provider({ "GET /invoice_payments": { json: { data: [], has_more: false } } });
    await expect(none.p.refundInvoice({ invoiceId: "in_x", intentId: "r" })).rejects.toThrow(code("not_found"));
  });

  it("ids in paths are encoded", async () => {
    const { p, calls } = provider({ "DELETE /subscriptions/a%2Fb": { json: { id: "x" } } });
    await p.cancel({ subscriptionId: "a/b", when: "now", intentId: "i" });
    expect(calls[0]?.path).toBe("/subscriptions/a%2Fb");
  });
});

describe("processor adapter: webhooks and catalogue", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    created: NOW_S,
    livemode: false,
    data: { object: { id: "in_1", customer: "cus_1" } },
  });

  it("verifies with any configured secret (rotation) and the key's mode", () => {
    const { p } = provider({});
    expect(p.verifyWebhook(body, signatureHeader("whsec_new", NOW_S, body), NOW).id).toBe("evt_1");
    expect(() => p.verifyWebhook(body, signatureHeader("whsec_other", NOW_S, body), NOW)).toThrow(WebhookRejected);
    const live = createStripeBillingProvider({ ...config, mode: "live" }, { fetch: stubFetch({}).fetch });
    expect(() => live.verifyWebhook(body, signatureHeader("whsec_old", NOW_S, body), NOW)).toThrow(/livemode_mismatch/);
  });

  const catalogue = {
    "GET /prices/price_plus": {
      json: price("price_plus", {
        product: { id: "prod_plus", active: true },
        active: true,
        recurring: { interval: "year" },
        tax_behavior: "exclusive",
        currency_options: { cad: { unit_amount: 1200 }, usd: { unit_amount: 900 } },
      }),
    },
    "GET /prices/price_storage": {
      json: price("price_storage", {
        product: { id: "prod_storage", active: true },
        unit_amount: 1000,
        recurring: { interval: "year" },
        tax_behavior: "exclusive",
        currency_options: { cad: { unit_amount: 1400 } },
      }),
    },
    "GET /prices/price_extra": {
      json: price("price_extra", {
        product: { id: "prod_extra", active: true },
        unit_amount: 100,
        recurring: { interval: "year" },
        tax_behavior: "exclusive",
        currency_options: { cad: { unit_amount: 140 } },
      }),
    },
    "GET /products/prod_supporter": { json: { id: "prod_supporter", active: true } },
  };

  it("a catalogue matching plans.ts has no drift", async () => {
    expect(await provider(catalogue).p.checkCatalogue()).toEqual([]);
  });

  it("reports every way the catalogue drifted", async () => {
    const { p } = provider({
      ...catalogue,
      "GET /prices/price_plus": {
        json: price("price_plus", {
          product: { id: "prod_plus", active: false },
          active: false,
          unit_amount: 1000,
          recurring: { interval: "month" },
          tax_behavior: "inclusive",
        }),
      },
      "GET /prices/price_storage": { status: 404, json: {} },
      "GET /products/prod_supporter": { json: { id: "prod_supporter", active: false } },
    });
    expect(await p.checkCatalogue()).toEqual(
      [
        { item: "plus", problem: "price is archived" },
        { item: "plus", problem: "product is archived" },
        { item: "plus", problem: "price isn't yearly" },
        { item: "plus", problem: "price isn't tax-exclusive" },
        { item: "plus", problem: "USD amount differs from plans.ts" },
        { item: "plus", problem: "CAD amount differs from plans.ts" },
        { item: "storage_block", problem: "price not found" },
      ].concat([{ item: "supporter_product", problem: "product is archived" }]),
    );
  });

  it("a missing Supporter product is drift; an outage during the check is an error, not drift", async () => {
    expect(
      await provider({ ...catalogue, "GET /products/prod_supporter": { status: 404, json: {} } }).p.checkCatalogue(),
    ).toEqual([{ item: "supporter_product", problem: "product not found" }]);
    await expect(
      provider({ ...catalogue, "GET /prices/price_plus": { status: 503 } }).p.checkCatalogue(),
    ).rejects.toThrow(code("unavailable"));
    await expect(
      provider({ ...catalogue, "GET /products/prod_supporter": { status: 503 } }).p.checkCatalogue(),
    ).rejects.toThrow(code("unavailable"));
  });

  it("idempotency keys are sha256 of scope, action and intent", () => {
    expect(idempotencyKey("a", "b", "c")).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey("a", "b", "c")).toBe(idempotencyKey("a", "b", "c"));
    expect(idempotencyKey("a", "b", "c")).not.toBe(idempotencyKey("a", "b", "d"));
  });
});
