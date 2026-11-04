// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The account's billing overview, starting a checkout and opening the customer portal (ADR-0029 §9, slice 8). Each
 * service checks permission and scope itself (unknown account → 404, missing permission → 403, act-as → 403) and
 * audits its refusals. The provider is called first, then our unit of work records what was started; the account's
 * state itself changes only through the sync, from the provider's answer.
 */
import { createHash } from "node:crypto";

import { BILLING, type Currency, isPaidPlan, PLANS, type PaidPlanId, type PlanId } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { EmailUnverifiedError, NotFoundError, ValidationError } from "../errors";
import { authorizeAudited, mutation, type MutationSpec } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";

import { addressCeilingOf } from "./ceilings";
import type { AccountBilling, BillingState, HoldSubject, PlanSource } from "./entity";
import {
  addonQuantityProblem,
  BillingError,
  checkoutBlock,
  entitlements,
  supporterAmountProblem,
} from "./entitlements";
import {
  assertRedirect,
  type BillingContext,
  billingPageUrl,
  billingTarget,
  callProvider,
  refuse,
  refuseActAs,
  requireProvider,
} from "./guards";
import { defaultBilling, effectivePlan, isPaidState } from "./lifecycle";

const DAY_MS = 86_400_000;
/** A checkout session lives an hour (ADR-0029 §2); no second one is started meanwhile. */
export const CHECKOUT_PENDING_MS = 3_600_000;
const YEAR_MS = 365 * DAY_MS;
const CURRENCIES: readonly Currency[] = ["USD", "CAD"];

/** The account's billing row, or its default (Free, or a staff grant on a paid plan), under the caller's unit of work. */
export async function billingOf(r: Repositories, accountId: string, now: Date): Promise<AccountBilling | null> {
  const account = await r.accounts.get(accountId);
  if (!account) return null;
  return (await r.billing.get(accountId)) ?? defaultBilling(accountId, account.plan, now);
}

export type BillingHoldView = {
  subjectType: HoldSubject;
  subjectId: string;
  /** The mailbox or alias address, or the domain name; null when the subject is gone. */
  label: string | null;
  heldAt: Date;
  /**
   * Held mailboxes: the end of the receive window. Mail keeps arriving after it for now (the receive block waits for a
   * refusal during the SMTP conversation, ADR-0029 update 2026-11-04); sending stays off.
   */
  receiveUntil: Date | null;
};

export type BillingOverview = {
  /** Billing is switched on for this deployment (`BILLING_PROVIDER` not `off`). */
  available: boolean;
  /** Public fact: `planned` until the launch change opens paid plans. */
  status: typeof BILLING.status;
  state: BillingState;
  stateSince: Date;
  /** The plan whose limits apply now. */
  plan: PlanId;
  planSource: PlanSource;
  paidPlan: PaidPlanId | null;
  currency: Currency | null;
  /** Per year, tax-exclusive, minor units: the Plus price or the Supporter amount. */
  planAmountMinor: number | null;
  /** Quantities the subscription renews with. */
  renewal: { storageBlocks: number; extraMailboxes: number };
  /** Add-ons in force now (capacity paid for stays to period end after a decrease). */
  entitled: { storageBlocks: number; extraMailboxes: number };
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  compUntil: Date | null;
  restrictedAt: Date | null;
  disputed: boolean;
  lapsedAt: Date | null;
  /** The account has a provider customer: "Manage payment and invoices" (the portal) can open. */
  portal: boolean;
  /** Why a checkout can't start now, or null. */
  checkoutBlocked: "already_subscribed" | "checkout_pending" | null;
  usage: {
    mailboxes: number;
    mailboxCeiling: number;
    people: number;
    peopleCeiling: number;
    poolBytes: number;
    /** Storage given to mailboxes that aren't held. */
    assignedBytes: number;
    /** Mailboxes + aliases + masked aliases (the ceiling itself is not published, rule 33). */
    addresses: number;
    /** Within 90 % of the address ceiling: the page says support can raise it. */
    addressesNearCeiling: boolean;
  };
  holds: BillingHoldView[];
  /**
   * From our row only (no provider call): the paid plan's first or renewal invoice may still be inside the 14-day
   * window. The refund itself re-checks the provider's invoice.
   */
  refund: { mayBeEligible: boolean; windowEndsAt: Date | null };
};

/** Where the current period started (the plans are yearly), from our row. */
const periodStart = (b: AccountBilling): Date | null =>
  b.currentPeriodEnd === null ? null : new Date(b.currentPeriodEnd.getTime() - YEAR_MS);

/**
 * `GET /api/accounts/:id/billing` (`billing.read`: Owner, Billing Administrator, Auditor; staff acting read-only).
 * Our row only: no provider call, so it is cheap and works with the provider down.
 */
export async function billingOverview(
  deps: Deps,
  ctx: Pick<BillingContext, "provider">,
  actor: Actor,
  accountId: string,
): Promise<BillingOverview> {
  authorize(actor, "billing.read", accountId);
  const now = deps.clock.now();
  return deps.uow.run(async (r) => {
    const b = await billingOf(r, accountId, now);
    if (!b) throw new NotFoundError();
    const [mailboxes, domains, aliases, members, holds, ceiling] = await Promise.all([
      r.mailboxes.listByAccount(accountId),
      r.domains.listByAccount(accountId),
      r.aliases.listByAccount(accountId),
      r.access.members(accountId),
      r.billing.holds(accountId),
      addressCeilingOf(deps, r, accountId),
    ]);
    const e = entitlements(b);
    const heldMailboxes = new Set(holds.filter((h) => h.subjectType === "mailbox").map((h) => h.subjectId));
    const labels = new Map<string, string>([
      ...mailboxes.map((m) => [`mailbox:${m.id}`, m.address] as const),
      ...domains.map((d) => [`domain:${d.id}`, d.name] as const),
      ...aliases.map((a) => [`alias:${a.id}`, a.address] as const),
    ]);
    const addresses = mailboxes.length + aliases.length;
    const start = periodStart(b);
    const windowEndsAt = start === null ? null : new Date(start.getTime() + BILLING.refundWindowDays * DAY_MS);
    return {
      available: ctx.provider !== null,
      status: BILLING.status,
      state: b.state,
      stateSince: b.stateSince,
      plan: effectivePlan(b),
      planSource: b.planSource,
      paidPlan: b.paidPlan,
      currency: b.currency,
      planAmountMinor: b.planAmountMinor,
      renewal: { storageBlocks: b.storageBlocks, extraMailboxes: b.extraMailboxes },
      entitled: { storageBlocks: e.storageBlocks, extraMailboxes: e.extraMailboxes },
      currentPeriodEnd: b.currentPeriodEnd,
      cancelAt: b.cancelAt,
      compUntil: b.compUntil,
      restrictedAt: b.restrictedAt,
      disputed: b.disputedAt !== null,
      lapsedAt: b.lapsedAt,
      portal: b.providerCustomerId !== null,
      checkoutBlocked: checkoutBlock(b, now),
      usage: {
        mailboxes: mailboxes.length,
        mailboxCeiling: e.mailboxCeiling,
        people: members.length,
        peopleCeiling: e.peopleCeiling,
        poolBytes: e.poolBytes,
        assignedBytes: mailboxes.filter((m) => !heldMailboxes.has(m.id)).reduce((s, m) => s + m.quotaBytes, 0),
        addresses,
        addressesNearCeiling: addresses >= ceiling * 0.9,
      },
      holds: holds.map((h) => ({
        subjectType: h.subjectType,
        subjectId: h.subjectId,
        label: labels.get(`${h.subjectType}:${h.subjectId}`) ?? null,
        heldAt: h.heldAt,
        receiveUntil: h.receiveUntil,
      })),
      refund: {
        mayBeEligible:
          b.state === "active" &&
          b.planSource === "stripe" &&
          b.disputedAt === null &&
          b.selfServiceRefundAt === null &&
          b.lastInvoiceStatus === "paid" &&
          windowEndsAt !== null &&
          now <= windowEndsAt,
        windowEndsAt,
      },
    };
  });
}

export type CheckoutRequest = {
  plan?: unknown;
  currency?: unknown;
  supporterAmountMinor?: unknown;
  storageBlocks?: unknown;
  extraMailboxes?: unknown;
};

export type ParsedCheckout = {
  plan: PaidPlanId;
  currency: Currency;
  /** The Plus price, or the Supporter amount chosen. */
  amountMinor: number;
  supporterAmountMinor?: number;
  storageBlocks: number;
  extraMailboxes: number;
};

const wholeOrZero = (v: unknown): number => (v === undefined || v === null ? 0 : typeof v === "number" ? v : NaN);

/** Validates a checkout request against the public facts (400 with what is wrong). */
export function parseCheckout(input: CheckoutRequest): ParsedCheckout {
  const plan = input.plan;
  if (typeof plan !== "string" || !isPaidPlan(plan)) throw new ValidationError("Choose Plus or Supporter.");
  const currency = input.currency;
  if (typeof currency !== "string" || !CURRENCIES.includes(currency as Currency)) {
    throw new ValidationError("Choose USD or CAD.");
  }
  const cur = currency as Currency;
  const storageBlocks = wholeOrZero(input.storageBlocks);
  const extraMailboxes = wholeOrZero(input.extraMailboxes);
  const problem =
    addonQuantityProblem("storageBlocks", storageBlocks) ?? addonQuantityProblem("extraMailboxes", extraMailboxes);
  if (problem) throw new ValidationError(problem);
  if (plan === "supporter") {
    const amount = input.supporterAmountMinor;
    if (typeof amount !== "number") throw new ValidationError("Choose how much to pay a year for Supporter.");
    const wrong = supporterAmountProblem(cur, amount);
    if (wrong) throw new ValidationError(wrong);
    return { plan, currency: cur, amountMinor: amount, supporterAmountMinor: amount, storageBlocks, extraMailboxes };
  }
  if (input.supporterAmountMinor !== undefined && input.supporterAmountMinor !== null) {
    throw new ValidationError("A Supporter amount goes only with the Supporter plan.");
  }
  return { plan, currency: cur, amountMinor: PLANS.plus.price?.[cur] ?? 0, storageBlocks, extraMailboxes };
}

/**
 * The checkout's intent id: the same request in the same billing state within the same hour gets the same id, so a
 * double click or a retried request reuses the provider's session (its idempotency key) instead of opening a second
 * one. The state's start is part of it: after a subscription ends (a refund, a lapse), a new checkout is a new intent,
 * never the earlier, completed session.
 */
export function checkoutIntentId(accountId: string, c: ParsedCheckout, now: Date, stateSince: Date): string {
  const hour = Math.floor(now.getTime() / CHECKOUT_PENDING_MS);
  return createHash("sha256")
    .update(
      [accountId, c.plan, c.currency, c.amountMinor, c.storageBlocks, c.extraMailboxes, hour, stateSince.getTime()]
        .map(String)
        .join(":"),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * The account's provider customer, created once (ADR-0029 §9; the processor's idempotency key lasts a day, so the id
 * is stored at once, audited `billing.customer_created`). A concurrent request that stored one first wins; its id is
 * used.
 */
async function customerFor(
  deps: Deps,
  ctx: BillingContext & { provider: NonNullable<BillingContext["provider"]> },
  actor: Extract<Actor, { kind: "user" }>,
  accountId: string,
  b: AccountBilling,
  accountName: string,
  req: RequestMeta,
  spec: MutationSpec,
): Promise<string> {
  if (b.providerCustomerId !== null) return b.providerCustomerId;
  const { customerId } = await callProvider(deps, actor, req, spec, () =>
    ctx.provider.ensureCustomer({ accountId, email: actor.email, name: accountName }),
  );
  return mutation(deps, actor, req, { ...spec, action: "billing.customer_created" }, async (r) => {
    await r.accounts.lock(accountId);
    const now = deps.clock.now();
    const current = await billingOf(r, accountId, now);
    if (!current) throw new NotFoundError();
    if (current.providerCustomerId !== null) {
      return { result: current.providerCustomerId, meta: { customerId: current.providerCustomerId, reused: true } };
    }
    await r.billing.save({ ...current, providerCustomerId: customerId, updatedAt: now });
    return { result: customerId, meta: { customerId } };
  });
}

/**
 * `POST /api/accounts/:id/billing/checkout` (`billing.manage` ★: Owner, Billing Administrator). From Free, lapsed or a
 * comp only (409 `already_subscribed`), not while another checkout is open (409 `checkout_pending`, an hour), with a
 * confirmed console email (403 `email_unverified`), in the account's currency once it has one. Returns the provider's
 * checkout URL (only from an expected origin). Audited `billing.checkout_started` with the plan and amounts; the plan
 * itself starts when the sync sees the paid subscription.
 */
export async function startCheckout(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  input: CheckoutRequest,
  req: RequestMeta,
): Promise<{ url: string }> {
  const spec: MutationSpec = {
    action: "billing.checkout_started",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  if (actor.kind !== "user") throw new NotFoundError();
  const c = parseCheckout(input);
  const now = deps.clock.now();
  const pre = await deps.uow.run(async (r) => ({
    account: await r.accounts.get(accountId),
    billing: await billingOf(r, accountId, now),
    verified: await r.access.emailVerified(actor.userId),
  }));
  if (!pre.account || !pre.billing) throw new NotFoundError();
  if (!pre.verified) await refuse(deps, actor, req, spec, "email_unverified", new EmailUnverifiedError());
  const blocked = checkoutBlock(pre.billing, now);
  if (blocked === "already_subscribed") {
    await refuse(
      deps,
      actor,
      req,
      spec,
      blocked,
      new BillingError(blocked, "This account already has a paid plan: change it on the Billing page."),
    );
  }
  if (blocked === "checkout_pending") {
    await refuse(
      deps,
      actor,
      req,
      spec,
      blocked,
      new BillingError(blocked, "A checkout was started in the last hour. Finish it, or try again later."),
    );
  }
  if (pre.billing.currency !== null && pre.billing.currency !== c.currency) {
    throw new ValidationError(`This account pays in ${pre.billing.currency}.`);
  }

  const stateSince = pre.billing.stateSince;
  const withProvider = { ...ctx, provider };
  const customerId = await customerFor(deps, withProvider, actor, accountId, pre.billing, pre.account.name, req, spec);
  const { url } = await callProvider(deps, actor, req, spec, () =>
    provider.createCheckout({
      accountId,
      customerId,
      currency: c.currency,
      plan: c.plan,
      ...(c.supporterAmountMinor === undefined ? {} : { supporterAmountMinor: c.supporterAmountMinor }),
      storageBlocks: c.storageBlocks,
      extraMailboxes: c.extraMailboxes,
      successUrl: billingPageUrl(ctx, accountId, "?checkout=done"),
      cancelUrl: billingPageUrl(ctx, accountId, "?checkout=cancelled"),
      intentId: checkoutIntentId(accountId, c, now, stateSince),
    }),
  );
  const safe = assertRedirect(ctx, url);
  return mutation(deps, actor, req, spec, async (r) => {
    await r.accounts.lock(accountId);
    const at = deps.clock.now();
    const current = await billingOf(r, accountId, at);
    if (!current) throw new NotFoundError();
    await r.billing.save({
      ...current,
      checkoutPendingUntil: new Date(at.getTime() + CHECKOUT_PENDING_MS),
      updatedAt: at,
    });
    return {
      result: { url: safe },
      meta: {
        plan: c.plan,
        currency: c.currency,
        amountMinor: c.amountMinor,
        storageBlocks: c.storageBlocks,
        extraMailboxes: c.extraMailboxes,
      },
    };
  });
}

/**
 * `POST /api/accounts/:id/billing/portal` (`billing.manage` ★): the provider's customer portal (payment method,
 * billing address, tax ids, invoices, cancel at period end), for an account that has a provider customer (409
 * `not_subscribed` otherwise). Works in every billing state, so a restricted account can fix its card. Audited
 * `billing.portal_opened`.
 */
export async function openBillingPortal(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  req: RequestMeta,
): Promise<{ url: string }> {
  const spec: MutationSpec = {
    action: "billing.portal_opened",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  if (!b) throw new NotFoundError();
  const customerId = b.providerCustomerId;
  if (customerId === null) {
    return refuse(
      deps,
      actor,
      req,
      spec,
      "not_subscribed",
      new BillingError("not_subscribed", "There are no payments or invoices to manage yet."),
    );
  }
  const { url } = await callProvider(deps, actor, req, spec, () =>
    provider.createPortalSession({ customerId, returnUrl: billingPageUrl(ctx, accountId) }),
  );
  const safe = assertRedirect(ctx, url);
  return mutation(deps, actor, req, spec, async () => ({
    result: { url: safe },
    meta: { state: b.state },
  }));
}

/** Whether a billing state still has a paid subscription the person can change or cancel. */
export const hasLiveSubscription = (b: AccountBilling): boolean =>
  isPaidState(b.state) && b.planSource === "stripe" && b.providerSubscriptionId !== null;
