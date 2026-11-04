// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { z } from "zod";

import {
  billingProviderKind,
  type FakeBillingProvider,
  type FakeObjectView,
  isFakeBillingProvider,
} from "@anhourmail/adapters/billing";
import { type Actor, authorize, ConflictError, NotFoundError } from "@anhourmail/core";
import { BillingProviderError } from "@anhourmail/core/billing";
import { log } from "@anhourmail/server/log";

import { receiveBillingWebhook } from "./billing-webhook";
import { container } from "./container";
import { env } from "./env";

/**
 * Dev billing without the payment processor (ADR-0029 §3): the fake checkout and portal pages (`/dev/billing/…`) and
 * `POST /api/dev/billing/simulate` drive the fake provider, whose signed events go through the real webhook route, so
 * dev exercises signature checks, ingestion, the worker's sync and the mail-server jobs end to end.
 *
 * Unreachable in production, three layers: (1) the fake provider refuses to be built with `NODE_ENV=production` (boot
 * fails: `env.ts`, `createFakeBillingProvider`); (2) this module answers 404 on every request unless billing is the
 * fake and `NODE_ENV` isn't production (`devBilling`); (3) `proxy.ts` answers 404 for `/dev/` and `/api/dev/` on
 * production builds before routing (`host-routing.ts`).
 */

const l = log.child({ component: "dev-billing" });

/** Layer 2: the fake provider in a non-production process, else null (callers answer 404). */
export function devBilling(): FakeBillingProvider | null {
  // The process environment first: a production process answers 404 before reading any configuration.
  if (process.env.NODE_ENV === "production") return null;
  const e = env();
  if (e.NODE_ENV === "production") return null;
  if (billingProviderKind({ ...process.env, NODE_ENV: e.NODE_ENV }) !== "fake") return null;
  const provider = container().billing;
  return isFakeBillingProvider(provider) ? provider : null;
}

/** The fake provider, or a 404 (layer 2). */
export function requireDevBilling(): FakeBillingProvider {
  const p = devBilling();
  if (!p) throw new NotFoundError();
  return p;
}

export const SIMULATE_ACTIONS = [
  "pay",
  "decline",
  "card_fails",
  "card_works",
  "advance_clock",
  "exhaust_retries",
  "pay_open_invoice",
  "pause",
  "cancel_at_period_end",
  "undo_cancel",
  "refund",
  "open_dispute",
  "close_dispute_won",
  "close_dispute_lost",
] as const;
export type SimulateAction = (typeof SIMULATE_ACTIONS)[number];

const CHECKOUT_ACTIONS: readonly SimulateAction[] = ["pay", "decline"];

export const SimulateBody = z
  .object({
    action: z.enum(SIMULATE_ACTIONS),
    /** A fake checkout session (pay, decline), or a fake customer (everything else). */
    sessionId: z.string().min(1).max(100).optional(),
    customerId: z.string().min(1).max(100).optional(),
    days: z.number().int().min(1).max(800).optional(),
  })
  .refine((b) => (CHECKOUT_ACTIONS.includes(b.action) ? b.sessionId !== undefined : b.customerId !== undefined), {
    message: "Checkout actions need sessionId; the others need customerId.",
  })
  .refine((b) => b.action !== "advance_clock" || b.days !== undefined, { message: "advance_clock needs days." });
export type SimulateInput = z.infer<typeof SimulateBody>;

/**
 * The fake object a dev page or the simulate route acts on, when the actor may manage billing in its account
 * (`billing.manage`: 404 outside the account, 403 without the permission, like the real billing routes). Unknown → 404.
 */
export async function devObjectFor(
  provider: FakeBillingProvider,
  actor: Actor,
  kind: "checkout" | "customer",
  id: string,
): Promise<FakeObjectView> {
  const view = await provider.describe(kind, id);
  if (!view) throw new NotFoundError();
  authorize(actor, "billing.manage", view.accountId);
  return view;
}

async function run(provider: FakeBillingProvider, view: FakeObjectView, input: SimulateInput): Promise<void> {
  const customer = view.customerId;
  const sub = view.subscription;
  const needSub = () => {
    if (!sub) throw new NotFoundError("No subscription.");
    return sub;
  };
  const intentId = `dev-${Date.now().toString(36)}`;
  switch (input.action) {
    case "pay":
    case "decline":
      await provider.completeCheckout(view.checkout?.id ?? "", input.action);
      return;
    case "card_fails":
    case "card_works":
      await provider.setCardFails(customer, input.action === "card_fails");
      return;
    case "advance_clock":
      await provider.advanceClock(input.days ?? 1);
      return;
    case "exhaust_retries":
      await provider.exhaustRetries(customer);
      return;
    case "pay_open_invoice":
      await provider.payOpenInvoice(customer);
      return;
    case "pause":
      await provider.pause(customer);
      return;
    case "cancel_at_period_end":
      await provider.cancel({ subscriptionId: needSub().id, when: "period_end", intentId });
      return;
    case "undo_cancel":
      await provider.undoCancel({ subscriptionId: needSub().id, intentId });
      return;
    case "refund":
      await provider.refundLatest(customer);
      return;
    case "open_dispute":
      await provider.openDispute(customer);
      return;
    case "close_dispute_won":
    case "close_dispute_lost":
      await provider.closeDispute(customer, input.action === "close_dispute_won" ? "won" : "lost");
      return;
  }
}

/**
 * Delivers every event the fake has waiting through the real webhook route in this process (signature check,
 * ingestion, the account's sync queued for the worker). Returns how many were delivered.
 */
export async function deliverFakeEvents(provider: FakeBillingProvider): Promise<number> {
  const deliveries = await provider.drainDeliveries();
  const url = `${env().APP_URL.replace(/\/+$/, "")}/api/billing/webhook`;
  for (const d of deliveries) {
    const res = await receiveBillingWebhook(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": d.signature },
        body: d.body,
      }),
    );
    if (!res.ok) l.warn("fake billing event not accepted", { status: res.status });
  }
  return deliveries.length;
}

/** `POST /api/dev/billing/simulate`: one fake provider action, then its events delivered. */
export async function simulate(
  actor: Actor,
  input: SimulateInput,
): Promise<{ delivered: number; view: FakeObjectView | null }> {
  const provider = requireDevBilling();
  const kind = CHECKOUT_ACTIONS.includes(input.action) ? "checkout" : "customer";
  const view = await devObjectFor(
    provider,
    actor,
    kind,
    (kind === "checkout" ? input.sessionId : input.customerId) ?? "",
  );
  try {
    await run(provider, view, input);
  } catch (err) {
    // The fake's own refusals ("no open invoice", "the checkout session is no longer open"): its messages are ours.
    if (err instanceof BillingProviderError) throw new ConflictError(err.message);
    throw err;
  }
  const delivered = await deliverFakeEvents(provider);
  return { delivered, view: await provider.describe("customer", view.customerId) };
}
