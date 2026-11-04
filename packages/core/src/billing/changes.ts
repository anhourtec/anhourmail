// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan and add-on changes, cancelling and the self-service refund (ADR-0029 §7, §9; slice 9). Each service checks
 * permission and scope itself (unknown account → 404, missing permission → 403, act-as → 403) and audits its refusals.
 *
 * - An increase is charged now, prorated, and only with the amount confirmed: the person sees the preview and sends
 *   that amount back (`confirmAmountMinor`); the service previews again just before charging and refuses (409
 *   `confirmation_required`) when it differs. Never auto-charged.
 * - A decrease, a Plus ↔ Supporter switch and a Supporter amount change cost nothing now and renew at the new figure;
 *   a decrease that would leave the account over the new figure at renewal is refused (409 `addon_in_use`).
 * - Cancelling (at period end), undoing it and the refund need a fresh password step-up (ADR-0028).
 * - The refund is the 14-day self-service one: the first or a renewal invoice, paid at most 14 days ago, nothing refunded
 *   yet, no open dispute. It refunds the invoice in full and ends the subscription now; the sync then lapses the account.
 *
 * The provider is called first, then our unit of work records the request and queues the account's sync; the account's
 * state follows from the sync, so a crash between the two heals on the next sync.
 */
import { randomUUID } from "node:crypto";

import { BILLING, type Currency, isPaidPlan, type PaidPlanId } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { authorizeAudited, mutation, type MutationSpec } from "../mutation";
import type { AuditAction } from "../audit/catalogue";
import type { Deps, Repositories, RequestMeta } from "../ports";

import { billingOf, hasLiveSubscription } from "./checkout";
import type { AccountBilling } from "./entity";
import {
  addonQuantityProblem,
  type AddonUsage,
  assertDecreaseFits,
  BillingError,
  type ChangeRequest,
  changeProration,
  type RefundRefusal,
  refundEligibility,
  supporterAmountProblem,
} from "./entitlements";
import {
  type BillingContext,
  type BillingSession,
  billingTarget,
  callProvider,
  providerError,
  refuse,
  refuseActAs,
  requireProvider,
  requireStepUp,
  unavailable,
} from "./guards";
import type { ProviderInvoice, SubscriptionChange } from "./ports";

export type ChangeInput = {
  plan?: unknown;
  supporterAmountMinor?: unknown;
  storageBlocks?: unknown;
  extraMailboxes?: unknown;
};

/** What a change costs now and when it takes effect. */
export type ChangePreview = {
  /** Charged now when confirmed (increases only, prorated, before tax); 0 for everything else. */
  amountDueNowMinor: number;
  currency: Currency;
  /** `now`: charged and in force at once (increases); `renewal`: the subscription renews at the new figure. */
  billed: "now" | "renewal";
};

const DAY_MS = 86_400_000;

/** Validates a change against the account's subscription (400 with what is wrong). */
export function parseChange(input: ChangeInput, b: Pick<AccountBilling, "paidPlan" | "currency">): ChangeRequest {
  const out: ChangeRequest = {};
  if (input.plan !== undefined && input.plan !== null) {
    if (typeof input.plan !== "string" || !isPaidPlan(input.plan))
      throw new ValidationError("Choose Plus or Supporter.");
    out.plan = input.plan;
  }
  for (const kind of ["storageBlocks", "extraMailboxes"] as const) {
    const v = input[kind];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : NaN;
    const problem = addonQuantityProblem(kind, n);
    if (problem) throw new ValidationError(problem);
    out[kind] = n;
  }
  const plan: PaidPlanId | null = out.plan ?? b.paidPlan;
  if (input.supporterAmountMinor !== undefined && input.supporterAmountMinor !== null) {
    if (plan !== "supporter") throw new ValidationError("A Supporter amount goes only with the Supporter plan.");
    if (typeof input.supporterAmountMinor !== "number" || b.currency === null) {
      throw new ValidationError("Choose how much to pay a year for Supporter.");
    }
    const wrong = supporterAmountProblem(b.currency, input.supporterAmountMinor);
    if (wrong) throw new ValidationError(wrong);
    out.supporterAmountMinor = input.supporterAmountMinor;
  } else if (out.plan === "supporter" && b.paidPlan !== "supporter") {
    throw new ValidationError("Choose how much to pay a year for Supporter.");
  }
  return out;
}

/** What the account uses now: every mailbox (held, suspended and deleting ones still hold their mail). */
async function usageOf(r: Repositories, accountId: string): Promise<AddonUsage> {
  const mailboxes = await r.mailboxes.listByAccount(accountId);
  return { mailboxes: mailboxes.length, assignedQuotaBytes: mailboxes.reduce((s, m) => s + m.quotaBytes, 0) };
}

/** The audit action for a change: a plan switch, else a Supporter amount, else add-ons. */
function changeAction(b: AccountBilling, c: ChangeRequest): AuditAction {
  if (c.plan !== undefined && c.plan !== b.paidPlan) return "billing.plan_changed";
  if (c.supporterAmountMinor !== undefined && c.supporterAmountMinor !== b.planAmountMinor) {
    return "billing.supporter_amount_changed";
  }
  return "billing.addons_changed";
}

type Planned = {
  change: SubscriptionChange;
  next: { storageBlocks: number; extraMailboxes: number };
  plan: PaidPlanId;
};

/**
 * The provider change a request means, or the refusal: no live subscription (409 `not_subscribed`), nothing to change
 * or a mix of directions (400 `invalid_change`), an increase while restricted (403 `billing_restricted`: the open payment
 * comes first), a decrease that doesn't fit at renewal (409 `addon_in_use`).
 */
function plan(b: AccountBilling, c: ChangeRequest, usage: AddonUsage): Planned {
  if (!hasLiveSubscription(b) || b.paidPlan === null || b.providerSubscriptionId === null) {
    throw new BillingError("not_subscribed", "This account has no paid subscription to change.");
  }
  const proration = changeProration(b, c);
  if (proration === "charge_now" && b.state === "restricted") {
    throw new BillingError(
      "billing_restricted",
      "Pay the open invoice first: capacity can't be added while the account is restricted.",
    );
  }
  const next = {
    storageBlocks: c.storageBlocks ?? b.storageBlocks,
    extraMailboxes: c.extraMailboxes ?? b.extraMailboxes,
  };
  const target = c.plan ?? b.paidPlan;
  if (proration === "none") assertDecreaseFits(target, next, usage);
  return {
    change: {
      subscriptionId: b.providerSubscriptionId,
      intentId: randomUUID(),
      ...(c.plan === undefined ? {} : { plan: c.plan }),
      ...(c.supporterAmountMinor === undefined ? {} : { supporterAmountMinor: c.supporterAmountMinor }),
      ...(c.storageBlocks === undefined ? {} : { storageBlocks: c.storageBlocks }),
      ...(c.extraMailboxes === undefined ? {} : { extraMailboxes: c.extraMailboxes }),
      proration,
    },
    next,
    plan: target,
  };
}

/**
 * `POST /api/accounts/:id/billing/preview` (`billing.manage` ★): what a proposed change costs now. Changes nothing and
 * writes nothing (no audit: a read); the provider is asked only for increases (everything else is 0 now).
 */
export async function previewBillingChange(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  input: ChangeInput,
): Promise<ChangePreview> {
  authorize(actor, "billing.manage", accountId);
  if (actor.kind === "user" && actor.actingAs)
    throw new ForbiddenError("Billing can't be changed while acting as someone.");
  const provider = ctx.provider;
  if (!provider) throw unavailable();
  const now = deps.clock.now();
  const { b, usage } = await deps.uow.run(async (r) => ({
    b: await billingOf(r, accountId, now),
    usage: await usageOf(r, accountId),
  }));
  if (!b) throw new NotFoundError();
  const p = plan(b, parseChange(input, b), usage);
  const currency = b.currency ?? "USD";
  if (p.change.proration === "none") return { amountDueNowMinor: 0, currency, billed: "renewal" };
  try {
    const out = await provider.previewChange(p.change);
    return { amountDueNowMinor: out.amountDueNowMinor, currency: out.currency, billed: "now" };
  } catch (err) {
    throw providerError(err);
  }
}

/**
 * `POST /api/accounts/:id/billing/change` (`billing.manage` ★): add-on quantities, Plus ↔ Supporter (features switch now,
 * price at renewal) or the Supporter amount (at renewal). An increase needs `confirmAmountMinor` equal to what it charges
 * now (409 `confirmation_required` otherwise, with the amount in the message). A declined card is 402 `card_declined`
 * and changes nothing. Audited as `billing.addons_changed`, `billing.plan_changed` or `billing.supporter_amount_changed`
 * with the amount charged now; the account's sync is queued and records what the provider then reports.
 */
export async function changeBilling(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  input: ChangeInput & { confirmAmountMinor?: unknown },
  req: RequestMeta,
): Promise<ChangePreview> {
  const base: MutationSpec = {
    action: "billing.addons_changed",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, base);
  await refuseActAs(deps, actor, req, base);
  const provider = await requireProvider(deps, actor, req, base, ctx);
  const now = deps.clock.now();
  const { b, usage } = await deps.uow.run(async (r) => ({
    b: await billingOf(r, accountId, now),
    usage: await usageOf(r, accountId),
  }));
  if (!b) throw new NotFoundError();
  const c = parseChange(input, b);
  const spec: MutationSpec = { ...base, action: changeAction(b, c) };
  let p: Planned;
  try {
    p = plan(b, c, usage);
  } catch (err) {
    if (err instanceof BillingError) return refuse(deps, actor, req, spec, err.code, err);
    throw err;
  }

  let chargedNowMinor = 0;
  let currency: Currency = b.currency ?? "USD";
  if (p.change.proration === "charge_now") {
    const quote = await callProvider(deps, actor, req, spec, () => provider.previewChange(p.change));
    currency = quote.currency;
    if (input.confirmAmountMinor !== quote.amountDueNowMinor) {
      return refuse(
        deps,
        actor,
        req,
        spec,
        "confirmation_required",
        new BillingError(
          "confirmation_required",
          `This change charges ${(quote.amountDueNowMinor / 100).toFixed(2)} ${quote.currency} now, before tax. Confirm that amount to go ahead.`,
        ),
      );
    }
    chargedNowMinor = quote.amountDueNowMinor;
  }
  await callProvider(deps, actor, req, spec, () => provider.changeSubscription(p.change));

  return mutation(deps, actor, req, spec, async (r) => {
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: deps.clock.now() });
    return {
      result: {
        amountDueNowMinor: chargedNowMinor,
        currency,
        billed: p.change.proration === "charge_now" ? "now" : "renewal",
      },
      meta: {
        fromPlan: b.paidPlan,
        toPlan: p.plan,
        storageBlocksFrom: b.storageBlocks,
        storageBlocksTo: p.next.storageBlocks,
        extraMailboxesFrom: b.extraMailboxes,
        extraMailboxesTo: p.next.extraMailboxes,
        ...(c.supporterAmountMinor === undefined
          ? {}
          : { fromMinor: b.planAmountMinor, toMinor: c.supporterAmountMinor }),
        chargedNowMinor,
        currency,
        billed: p.change.proration === "charge_now" ? "now" : "renewal",
      },
    };
  });
}

/** The account's live provider subscription, for cancelling (409 `not_subscribed` when there is none we manage). */
function liveSubscriptionId(b: AccountBilling | null): string {
  if (!b) throw new NotFoundError();
  if (!hasLiveSubscription(b) || b.providerSubscriptionId === null) {
    throw new BillingError("not_subscribed", "This account has no paid subscription to cancel.");
  }
  return b.providerSubscriptionId;
}

async function cancelOrUndo(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  session: BillingSession,
  req: RequestMeta,
  undo: boolean,
): Promise<{ cancelAt: Date | null }> {
  const spec: MutationSpec = {
    action: undo ? "billing.cancel_undone" : "billing.cancel_scheduled",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  let subscriptionId: string;
  try {
    subscriptionId = liveSubscriptionId(b);
    if (!undo && b?.cancelAt) {
      throw new BillingError("invalid_change", "The subscription already ends at the end of this period.");
    }
    if (undo && !b?.cancelAt) throw new BillingError("invalid_change", "No cancellation is scheduled.");
  } catch (err) {
    if (err instanceof BillingError) return refuse(deps, actor, req, spec, err.code, err);
    throw err;
  }
  // What the account's subscription allows comes first (the Billing page shows it anyway); then the step-up.
  await requireStepUp(deps, actor, req, spec, session);
  const intentId = randomUUID();
  await callProvider(deps, actor, req, spec, () =>
    undo
      ? provider.undoCancel({ subscriptionId, intentId })
      : provider.cancel({ subscriptionId, when: "period_end", intentId }),
  );
  const cancelAt = undo ? null : (b?.currentPeriodEnd ?? null);
  return mutation(deps, actor, req, spec, async (r) => {
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: deps.clock.now() });
    return { result: { cancelAt }, meta: undo ? {} : { at: cancelAt?.toISOString() ?? null } };
  });
}

/**
 * `POST /api/accounts/:id/billing/cancel` (`billing.manage` ★, fresh step-up): the subscription ends at the end of the
 * period already paid for; nothing changes until then and "Undo" stays possible. Audited `billing.cancel_scheduled`.
 */
export function cancelSubscription(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ cancelAt: Date | null }> {
  return cancelOrUndo(deps, ctx, actor, accountId, session, req, false);
}

/** `POST /api/accounts/:id/billing/undo-cancel` (`billing.manage` ★, fresh step-up). Audited `billing.cancel_undone`. */
export function undoCancelSubscription(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ cancelAt: Date | null }> {
  return cancelOrUndo(deps, ctx, actor, accountId, session, req, true);
}

const REFUND_MESSAGES: Record<RefundRefusal | "disputed", string> = {
  no_invoice: "There's no payment to refund.",
  not_paid: "There's no paid invoice to refund.",
  not_plan_invoice: "Only the first payment or a renewal can be refunded here. Contact support about other charges.",
  outside_window: `Refunds are possible within ${String(BILLING.refundWindowDays)} days of paying. Contact support about this one.`,
  already_refunded: "This payment was already refunded.",
  disputed: "This payment is disputed with the card issuer, so support handles it.",
};

/**
 * A refund that went through but whose cancellation didn't (a crash between the two): the same invoice, refunded in
 * full, still inside the window. Retrying finishes the cancellation instead of refusing.
 */
const refundedButLive = (inv: ProviderInvoice | null, now: Date): inv is ProviderInvoice =>
  inv !== null &&
  inv.status === "paid" &&
  inv.paidAt !== null &&
  inv.billingReason !== "other" &&
  inv.refundedMinor >= inv.amountMinor &&
  now.getTime() - inv.paidAt.getTime() <= BILLING.refundWindowDays * DAY_MS;

/**
 * `POST /api/accounts/:id/billing/refund` (`billing.manage` ★, fresh step-up): the 14-day self-service refund (ADR-0029
 * §9). Read fresh from the provider: the latest invoice must be the first or a renewal one, paid at most 14 days ago,
 * not refunded yet, and no dispute may be open (409 `refund_not_eligible` with the reason otherwise; staff handle the
 * rest). Refunds it in full (the provider reverses the tax) and ends the subscription now; the sync then lapses the
 * account (holds, never deletion). Audited `billing.refunded` (amount, currency, within the window, not staff).
 */
export async function refundSubscription(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ amountMinor: number; currency: Currency }> {
  const spec: MutationSpec = {
    action: "billing.refunded",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  if (!b) throw new NotFoundError();
  const notEligible = (reason: RefundRefusal | "disputed") =>
    refuse(
      deps,
      actor,
      req,
      spec,
      "refund_not_eligible",
      new BillingError("refund_not_eligible", REFUND_MESSAGES[reason]),
    );
  const customerId = b.providerCustomerId;
  if (!hasLiveSubscription(b) || customerId === null) {
    return refuse(
      deps,
      actor,
      req,
      spec,
      "not_subscribed",
      new BillingError("not_subscribed", "This account has no paid subscription to refund."),
    );
  }
  if (b.disputedAt !== null) return notEligible("disputed");
  await requireStepUp(deps, actor, req, spec, session);

  const sub = await callProvider(deps, actor, req, spec, () => provider.getSubscription(customerId));
  if (!sub) {
    return refuse(
      deps,
      actor,
      req,
      spec,
      "not_subscribed",
      new BillingError("not_subscribed", "This account has no paid subscription to refund."),
    );
  }
  if (sub.disputed || sub.disputeLost) return notEligible("disputed");
  const now = deps.clock.now();
  const inv = sub.latestInvoice;
  const eligible = refundEligibility(inv, now);
  const resumed = !eligible.eligible && refundedButLive(inv, now);
  if (!eligible.eligible && !resumed) return notEligible(eligible.reason);
  if (!inv) return notEligible("no_invoice");

  // One refund per invoice, ever: the intent is the invoice, so a retry never refunds twice.
  const refunded = resumed
    ? { amountMinor: inv.refundedMinor, currency: sub.currency }
    : await callProvider(deps, actor, req, spec, () =>
        provider.refundInvoice({ invoiceId: inv.id, intentId: `refund:${inv.id}` }),
      );
  await callProvider(deps, actor, req, spec, () =>
    provider.cancel({ subscriptionId: sub.subscriptionId, when: "now", intentId: `refund-cancel:${inv.id}` }),
  );
  return mutation(deps, actor, req, spec, async (r) => {
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: deps.clock.now() });
    return {
      result: refunded,
      meta: {
        invoiceId: inv.id,
        amountMinor: refunded.amountMinor,
        currency: refunded.currency,
        withinWindow: true,
        staff: false,
        ...(resumed ? { resumed: true } : {}),
      },
    };
  });
}
