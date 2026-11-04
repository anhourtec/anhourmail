// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The payment processor behind the `BillingProvider` port (ADR-0029 §1–§2), over plain `fetch` (`http.ts`). Product
 * and price ids come only from the environment (`config.ts`); amounts are checked against `plans.ts`, never the
 * reverse. State is read fresh (`getSubscription`) and mapped to the port's shape; unknown items are
 * `catalogue_drift`. Field shapes follow the pinned `STRIPE_API_VERSION` (subscription periods live on the items).
 */
import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  type BillingProvider,
  BillingProviderError,
  type CatalogueDrift,
  type CatalogueItem,
  type CheckoutInput,
  type DisputeOutcome,
  type InvoiceStatus,
  isLiveSubStatus,
  type ProviderInvoice,
  type ProviderSubscription,
  PROVIDER_SUB_STATUSES,
  type SubscriptionChange,
} from "@anhourmail/core/billing";
import { BILLING, type Currency, type PaidPlanId, PLANS, type Price } from "@anhourmail/shared/plans";

import type { StripeConfig } from "./config";
import type { FormValue } from "./form";
import { stripeHttp, type StripeHttp, type StripeHttpOptions } from "./http";
import { verifyWebhookBody } from "./signature";

/** Checkout sessions expire after an hour (the processor's minimum is 30 minutes). */
const CHECKOUT_TTL_S = 3600;
const CHECKOUT_ORIGIN = "https://checkout.stripe.com";
const PORTAL_ORIGIN = "https://billing.stripe.com";

/** `sha256(scope:action:intent)`: a retried request carries the same key, so it never applies twice. */
export const idempotencyKey = (scope: string, action: string, intentId: string): string =>
  createHash("sha256").update(`${scope}:${action}:${intentId}`).digest("hex");

const id = z.string().min(1).max(255);
const ref = z.union([id, z.object({ id })]);
const refId = (r: z.infer<typeof ref>): string => (typeof r === "string" ? r : r.id);

const priceSchema = z.object({
  id,
  product: z.union([id, z.object({ id, active: z.boolean() })]),
  active: z.boolean().optional(),
  currency: z.string(),
  unit_amount: z.number().int().nullable(),
  tax_behavior: z.string().nullable().optional(),
  recurring: z.object({ interval: z.string() }).nullable().optional(),
  currency_options: z
    .record(
      z.string(),
      z.object({ unit_amount: z.number().int().nullable(), tax_behavior: z.string().nullable().optional() }),
    )
    .optional(),
});
type StripePrice = z.infer<typeof priceSchema>;

const itemSchema = z.object({
  id,
  quantity: z.number().int().nonnegative().optional(),
  current_period_start: z.number().int(),
  current_period_end: z.number().int(),
  price: priceSchema,
});

const invoiceSchema = z.object({
  id,
  status: z.string().nullable(),
  total: z.number().int(),
  amount_paid: z.number().int(),
  billing_reason: z.string().nullable(),
  status_transitions: z.object({ paid_at: z.number().int().nullable() }),
});

const subscriptionSchema = z.object({
  id,
  customer: ref,
  status: z.enum(PROVIDER_SUB_STATUSES as [string, ...string[]]),
  currency: z.string(),
  cancel_at: z.number().int().nullable(),
  cancel_at_period_end: z.boolean(),
  items: z.object({ data: z.array(itemSchema) }),
  latest_invoice: z.union([id, invoiceSchema]).nullable(),
});
type StripeSubscription = z.infer<typeof subscriptionSchema>;

const list = <S extends z.ZodType>(s: S) => z.object({ data: z.array(s), has_more: z.boolean() });

const invoicePaymentSchema = z.object({
  payment: z.object({ type: z.string(), payment_intent: ref.nullable().optional() }),
});
const paymentIntentSchema = z.object({
  id,
  latest_charge: z.union([id, z.object({ id, amount_refunded: z.number().int() })]).nullable(),
});
const disputeSchema = z.object({ id, status: z.string() });

/**
 * The processor's dispute statuses as our outcomes. Every status that isn't a final win, loss or closed inquiry — the
 * unresolved ones and any we don't know (a newer API's) — is `open`, so it never lifts a restriction.
 */
export const disputeOutcome = (status: string): DisputeOutcome =>
  status === "won" || status === "lost" || status === "warning_closed" ? status : "open";

const paymentRef = z
  .union([id, z.object({ id, customer: ref.nullable().optional() })])
  .nullable()
  .optional();
const fullDisputeSchema = z.object({ id, status: z.string(), payment_intent: paymentRef, charge: paymentRef });

const toCurrency = (c: string): Currency | null => {
  const up = c.toUpperCase();
  return (BILLING.currencies as readonly string[]).includes(up) ? (up as Currency) : null;
};

const drift = (message: string): never => {
  throw new BillingProviderError("catalogue_drift", message);
};

const invoiceStatus = (s: string | null): InvoiceStatus =>
  s === "paid" || s === "uncollectible" || s === "void" ? s : "open"; // draft counts as not paid yet

const billingReason = (r: string | null): ProviderInvoice["billingReason"] =>
  r === "subscription_create" || r === "subscription_cycle" ? r : "other";

const at = (unix: number) => new Date(unix * 1000);

export type StripeAdapterOptions = Omit<StripeHttpOptions, "secretKey"> & { clock?: () => Date };

type ItemRole = "plan_plus" | "plan_supporter" | "storage" | "extra";

export function createStripeBillingProvider(config: StripeConfig, opts: StripeAdapterOptions = {}): BillingProvider {
  const http: StripeHttp = stripeHttp({ ...opts, secretKey: config.secretKey });
  const clock = opts.clock ?? (() => new Date());
  const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}`;

  const roleOf = (price: StripePrice): ItemRole | null => {
    if (config.prices.plus.includes(price.id)) return "plan_plus";
    if (refId(price.product) === config.supporterProduct) return "plan_supporter";
    if (config.prices.storageBlock.includes(price.id)) return "storage";
    if (config.prices.extraMailbox.includes(price.id)) return "extra";
    return null;
  };

  /** The item's yearly amount in the subscription's currency (a multi-currency price keeps the others in options). */
  async function amountIn(price: StripePrice, currency: Currency): Promise<number> {
    if (price.currency.toUpperCase() === currency && price.unit_amount !== null) return price.unit_amount;
    const full = await http.get(path("prices", price.id), { expand: ["currency_options"] }, priceSchema);
    const amount = full.currency_options?.[currency.toLowerCase()]?.unit_amount ?? null;
    return amount ?? drift(`price ${price.id} has no ${currency} amount`);
  }

  async function invoiceFacts(
    inv: z.infer<typeof invoiceSchema>,
  ): Promise<{ refundedMinor: number; disputed: boolean; disputeLost: boolean }> {
    if (inv.status !== "paid") return { refundedMinor: 0, disputed: false, disputeLost: false };
    const payments = await http.get(
      "/invoice_payments",
      { invoice: inv.id, status: "paid", limit: 10 },
      list(invoicePaymentSchema),
    );
    let refundedMinor = 0;
    let disputed = false;
    let disputeLost = false;
    for (const p of payments.data) {
      const pi = p.payment.payment_intent;
      if (p.payment.type !== "payment_intent" || !pi) continue;
      const intent = await http.get(
        path("payment_intents", refId(pi)),
        { expand: ["latest_charge"] },
        paymentIntentSchema,
      );
      const charge = intent.latest_charge;
      if (charge !== null && typeof charge !== "string") refundedMinor += charge.amount_refunded;
      const disputes = await http.get("/disputes", { payment_intent: intent.id, limit: 10 }, list(disputeSchema));
      for (const d of disputes.data) {
        const outcome = disputeOutcome(d.status);
        if (outcome === "open") disputed = true;
        else if (outcome === "lost") disputeLost = true;
      }
    }
    return { refundedMinor, disputed, disputeLost };
  }

  async function toProvider(sub: StripeSubscription): Promise<ProviderSubscription> {
    const currency = toCurrency(sub.currency) ?? drift(`subscription currency ${sub.currency} isn't offered`);
    let plan: { plan: PaidPlanId; item: z.infer<typeof itemSchema> } | null = null;
    let storageBlocks = 0;
    let extraMailboxes = 0;
    for (const item of sub.items.data) {
      const role = roleOf(item.price) ?? drift(`subscription item price ${item.price.id} isn't in the catalogue`);
      const qty = item.quantity ?? 1;
      if (role === "storage") storageBlocks += qty;
      else if (role === "extra") extraMailboxes += qty;
      else if (plan !== null) drift("a subscription has more than one plan item");
      else plan = { plan: role === "plan_plus" ? "plus" : "supporter", item };
    }
    if (plan === null) return drift("a subscription has no plan item");
    let latestInvoice: ProviderInvoice | null = null;
    let disputed = false;
    let disputeLost = false;
    let inv = sub.latest_invoice;
    if (typeof inv === "string") inv = await http.get(path("invoices", inv), {}, invoiceSchema);
    if (inv !== null) {
      const facts = await invoiceFacts(inv);
      disputed = facts.disputed;
      disputeLost = facts.disputeLost;
      const status = invoiceStatus(inv.status);
      latestInvoice = {
        id: inv.id,
        status,
        amountMinor: status === "paid" ? inv.amount_paid : inv.total,
        paidAt: inv.status_transitions.paid_at === null ? null : at(inv.status_transitions.paid_at),
        billingReason: billingReason(inv.billing_reason),
        refundedMinor: facts.refundedMinor,
      };
    }
    const periodEnd = at(plan.item.current_period_end);
    return {
      subscriptionId: sub.id,
      customerId: refId(sub.customer),
      status: sub.status as ProviderSubscription["status"],
      plan: plan.plan,
      currency,
      planAmountMinor: await amountIn(plan.item.price, currency),
      storageBlocks,
      extraMailboxes,
      currentPeriodStart: at(plan.item.current_period_start),
      currentPeriodEnd: periodEnd,
      cancelAt: sub.cancel_at !== null ? at(sub.cancel_at) : sub.cancel_at_period_end ? periodEnd : null,
      latestInvoice,
      disputed,
      disputeLost,
    };
  }

  const current = (ids: string[], what: string): string => ids[0] ?? drift(`no ${what} price configured`);

  const supporterPriceData = (currency: Currency, amountMinor: number): FormValue => ({
    product: config.supporterProduct,
    currency: currency.toLowerCase(),
    unit_amount: amountMinor,
    recurring: { interval: "year" },
    tax_behavior: "exclusive",
  });

  /** The `items` of an update: plan and add-on quantities (0 deletes the item). */
  function changeItems(sub: StripeSubscription, c: SubscriptionChange, currency: Currency): FormValue[] {
    const items: FormValue[] = [];
    const byRole = new Map(sub.items.data.map((i) => [roleOf(i.price), i]));
    const planItem = byRole.get("plan_plus") ?? byRole.get("plan_supporter");
    const nowSupporter = byRole.has("plan_supporter");
    const target = c.plan ?? (nowSupporter ? "supporter" : "plus");
    if (planItem && (c.plan !== undefined || c.supporterAmountMinor !== undefined)) {
      if (target === "supporter") {
        if (c.supporterAmountMinor === undefined) {
          throw new BillingProviderError("invalid_request", "a Supporter amount is required");
        }
        items.push({ id: planItem.id, price_data: supporterPriceData(currency, c.supporterAmountMinor) });
      } else if (nowSupporter) {
        items.push({ id: planItem.id, price: current(config.prices.plus, "Plus") });
      }
    }
    const addon = (role: "storage" | "extra", qty: number | undefined, prices: string[]) => {
      if (qty === undefined) return;
      const existing = byRole.get(role);
      if (existing) items.push(qty === 0 ? { id: existing.id, deleted: true } : { id: existing.id, quantity: qty });
      else if (qty > 0) items.push({ price: current(prices, role), quantity: qty });
    };
    addon("storage", c.storageBlocks, config.prices.storageBlock);
    addon("extra", c.extraMailboxes, config.prices.extraMailbox);
    return items;
  }

  const getRaw = (subscriptionId: string) =>
    http.get(path("subscriptions", subscriptionId), { expand: ["latest_invoice"] }, subscriptionSchema);

  const assertOrigin = (url: string, origin: string): string => {
    let ok: boolean;
    try {
      ok = new URL(url).origin === origin;
    } catch {
      ok = false;
    }
    if (!ok) throw new BillingProviderError("invalid_request", "the billing provider answered an unexpected URL");
    return url;
  };

  async function checkPrice(item: CatalogueItem, priceId: string, expected: Price | null): Promise<CatalogueDrift[]> {
    const out: CatalogueDrift[] = [];
    let price: StripePrice;
    try {
      price = await http.get(path("prices", priceId), { expand: ["currency_options", "product"] }, priceSchema);
    } catch (err) {
      if (err instanceof BillingProviderError && err.code === "not_found")
        return [{ item, problem: "price not found" }];
      throw err;
    }
    const problem = (p: string) => out.push({ item, problem: p });
    if (price.active === false) problem("price is archived");
    if (typeof price.product !== "string" && !price.product.active) problem("product is archived");
    if (price.recurring?.interval !== "year") problem("price isn't yearly");
    if (price.tax_behavior !== "exclusive") problem("price isn't tax-exclusive");
    if (expected === null) return out;
    for (const c of BILLING.currencies) {
      const lower = c.toLowerCase();
      const amount =
        price.currency === lower ? price.unit_amount : (price.currency_options?.[lower]?.unit_amount ?? null);
      if (amount !== expected[c]) problem(`${c} amount differs from plans.ts`);
    }
    return out;
  }

  return {
    kind: "stripe",

    ensureCustomer: async ({ accountId, email, name }) => {
      // The service creates a customer once and stores its id; the key makes a retried create return the same one.
      const c = await http.post(
        "/customers",
        { email, name, metadata: { account_id: accountId } },
        idempotencyKey(accountId, "customer", "create"),
        z.object({ id }),
      );
      return { customerId: c.id };
    },

    createCheckout: async (i: CheckoutInput) => {
      const lineItems: FormValue[] = [
        i.plan === "supporter"
          ? { price_data: supporterPriceData(i.currency, i.supporterAmountMinor ?? 0), quantity: 1 }
          : { price: current(config.prices.plus, "Plus"), quantity: 1 },
      ];
      if (i.storageBlocks > 0) {
        lineItems.push({ price: current(config.prices.storageBlock, "storage block"), quantity: i.storageBlocks });
      }
      if (i.extraMailboxes > 0) {
        lineItems.push({ price: current(config.prices.extraMailbox, "extra mailbox"), quantity: i.extraMailboxes });
      }
      const session = await http.post(
        "/checkout/sessions",
        {
          mode: "subscription",
          customer: i.customerId,
          client_reference_id: i.accountId,
          currency: i.currency.toLowerCase(),
          line_items: lineItems,
          subscription_data: { metadata: { account_id: i.accountId } },
          metadata: { account_id: i.accountId },
          automatic_tax: { enabled: true },
          billing_address_collection: "required",
          customer_update: { address: "auto", name: "auto" },
          tax_id_collection: { enabled: true },
          expires_at: Math.floor(clock().getTime() / 1000) + CHECKOUT_TTL_S,
          success_url: i.successUrl,
          cancel_url: i.cancelUrl,
        },
        idempotencyKey(i.accountId, "checkout", i.intentId),
        z.object({ id, url: z.string() }),
      );
      return { url: assertOrigin(session.url, CHECKOUT_ORIGIN) };
    },

    createPortalSession: async ({ customerId, returnUrl }) => {
      const s = await http.post(
        "/billing_portal/sessions",
        { customer: customerId, return_url: returnUrl, configuration: config.portalConfiguration ?? undefined },
        idempotencyKey(customerId, "portal", randomUUID()),
        z.object({ url: z.string() }),
      );
      return { url: assertOrigin(s.url, PORTAL_ORIGIN) };
    },

    getSubscription: async (customerId) => {
      let subs: z.infer<ReturnType<typeof list<typeof subscriptionSchema>>>;
      try {
        subs = await http.get(
          "/subscriptions",
          { customer: customerId, status: "all", limit: 20, expand: ["data.latest_invoice"] },
          list(subscriptionSchema),
        );
      } catch (err) {
        if (err instanceof BillingProviderError && err.code === "not_found") return null; // deleted customer
        throw err;
      }
      const live = subs.data.filter((s) => isLiveSubStatus(s.status as ProviderSubscription["status"]));
      if (live.length > 1) throw new BillingProviderError("multiple_subscriptions", "more than one live subscription");
      const sub = live[0];
      return sub ? toProvider(sub) : null;
    },

    previewChange: async (c) => {
      const sub = await getRaw(c.subscriptionId);
      const currency = toCurrency(sub.currency) ?? drift(`subscription currency ${sub.currency} isn't offered`);
      if (c.proration === "none") return { amountDueNowMinor: 0, currency };
      const preview = await http.post(
        "/invoices/create_preview",
        {
          customer: refId(sub.customer),
          subscription: sub.id,
          subscription_details: {
            items: changeItems(sub, c, currency),
            proration_behavior: "always_invoice",
            proration_date: Math.floor(clock().getTime() / 1000),
          },
        },
        idempotencyKey(c.subscriptionId, "preview", c.intentId),
        z.object({ amount_due: z.number().int(), currency: z.string() }),
      );
      return { amountDueNowMinor: preview.amount_due, currency };
    },

    changeSubscription: async (c) => {
      const sub = await getRaw(c.subscriptionId);
      const currency = toCurrency(sub.currency) ?? drift(`subscription currency ${sub.currency} isn't offered`);
      const updated = await http.post(
        path("subscriptions", c.subscriptionId),
        {
          items: changeItems(sub, c, currency),
          proration_behavior: c.proration === "charge_now" ? "always_invoice" : "none",
          // A declined charge fails the update (402 → card_declined) instead of leaving it half-applied.
          payment_behavior: c.proration === "charge_now" ? "error_if_incomplete" : undefined,
          expand: ["latest_invoice"],
        },
        idempotencyKey(c.subscriptionId, "change", c.intentId),
        subscriptionSchema,
      );
      return toProvider(updated);
    },

    cancel: async ({ subscriptionId, when, intentId }) => {
      if (when === "now") {
        await http.del(path("subscriptions", subscriptionId), z.object({ id }));
        return;
      }
      await http.post(
        path("subscriptions", subscriptionId),
        { cancel_at_period_end: true },
        idempotencyKey(subscriptionId, "cancel", intentId),
        z.object({ id }),
      );
    },

    undoCancel: async ({ subscriptionId, intentId }) => {
      await http.post(
        path("subscriptions", subscriptionId),
        { cancel_at_period_end: false },
        idempotencyKey(subscriptionId, "undo-cancel", intentId),
        z.object({ id }),
      );
    },

    refundInvoice: async ({ invoiceId, intentId }) => {
      const payments = await http.get(
        "/invoice_payments",
        { invoice: invoiceId, status: "paid", limit: 10 },
        list(invoicePaymentSchema),
      );
      const pi = payments.data.find((p) => p.payment.type === "payment_intent" && p.payment.payment_intent)?.payment
        .payment_intent;
      if (!pi) throw new BillingProviderError("not_found", "no payment to refund on that invoice");
      const refund = await http.post(
        "/refunds",
        { payment_intent: refId(pi), reason: "requested_by_customer", metadata: { invoice_id: invoiceId } },
        idempotencyKey(invoiceId, "refund", intentId),
        z.object({ amount: z.number().int(), currency: z.string() }),
      );
      const currency = toCurrency(refund.currency) ?? drift(`refund currency ${refund.currency} isn't offered`);
      return { amountMinor: refund.amount, currency };
    },

    verifyWebhook: (rawBody, header, now) =>
      verifyWebhookBody(rawBody, header, config.webhookSecrets, now, config.mode === "live"),

    getDispute: async (disputeId) => {
      // The dispute names its payment; the customer is on the payment intent (or the charge, for older payments).
      const d = await http.get(
        path("disputes", disputeId),
        { expand: ["payment_intent", "charge"] },
        fullDisputeSchema,
      );
      const customerOf = (x: z.infer<typeof paymentRef>): string | null =>
        x !== null && x !== undefined && typeof x !== "string" && x.customer ? refId(x.customer) : null;
      return {
        id: d.id,
        status: disputeOutcome(d.status),
        customerId: customerOf(d.payment_intent) ?? customerOf(d.charge),
        paymentIntentId: d.payment_intent ? refId(d.payment_intent) : null,
      };
    },

    checkCatalogue: async () => {
      const plus = PLANS.plus;
      const out: CatalogueDrift[] = [
        ...(await checkPrice("plus", current(config.prices.plus, "Plus"), plus.price)),
        ...(await checkPrice(
          "storage_block",
          current(config.prices.storageBlock, "storage block"),
          plus.storageBlockPrice,
        )),
        ...(await checkPrice(
          "extra_mailbox",
          current(config.prices.extraMailbox, "extra mailbox"),
          plus.extraMailboxPrice,
        )),
      ];
      try {
        const product = await http.get(
          path("products", config.supporterProduct),
          {},
          z.object({ id, active: z.boolean() }),
        );
        if (!product.active) out.push({ item: "supporter_product", problem: "product is archived" });
      } catch (err) {
        if (!(err instanceof BillingProviderError && err.code === "not_found")) throw err;
        out.push({ item: "supporter_product", problem: "product not found" });
      }
      return out;
    },
  };
}
