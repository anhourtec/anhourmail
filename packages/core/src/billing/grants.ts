// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plans given without a payment (ADR-0029 §8, §9; slice 12): staff grants (a paid plan with no end, or for a number of
 * days) and comps from invite codes, ending a grant, and the staff refund outside the self-service window. A grant
 * changes our state directly, in one unit of work under the account lock, through the same derivation and effects as
 * the sync (`deriveBilling`, `applyDerivation`): it works with billing off and needs no provider call. Every staff
 * action is audited in the account's own log as staff (rule 49), with a copy in the platform log.
 */
import { BILLING, isPaidPlan, type PaidPlanId, type PlanId } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { NotFoundError, ValidationError } from "../errors";
import { type AuditAlso, authorizeAudited, mutation, type MutationOutcome, type MutationSpec } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";

import { addressCeilingOf, DEV_ADDRESS_CEILING } from "./ceilings";
import { billingOf, hasLiveSubscription } from "./checkout";
import {
  type AccountBilling,
  type BillingDispute,
  type BillingState,
  type CatalogueStatus,
  isRestrictingDispute,
  type PlanSource,
} from "./entity";
import { BillingError, entitlements, refundEligibility } from "./entitlements";
import {
  type BillingContext,
  type BillingSession,
  billingTarget,
  callProvider,
  refuse,
  refuseActAs,
  requireProvider,
  requireStepUp,
} from "./guards";
import { computeHolds } from "./holds";
import { type BillingChange, deriveBilling, effectivePlan, type StateReason } from "./lifecycle";
import { applyDerivation, holdResources } from "./sync";

const DAY_MS = 86_400_000;
const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Days a staff grant or a comp may run (a typo guard; a grant with no end is `days: null`). */
export const GRANT_MAX_DAYS = 365;

export type PlanGrant = { plan: PaidPlanId; days: number | null };

/** `{ plan, days }`: Plus or Supporter, and 1–365 days or null for no end (400 otherwise). */
export function parsePlanGrant(input: { plan?: unknown; days?: unknown }): PlanGrant {
  if (typeof input.plan !== "string" || !isPaidPlan(input.plan)) throw new ValidationError("Choose Plus or Supporter.");
  const days = input.days ?? null;
  if (days !== null && (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > GRANT_MAX_DAYS)) {
    throw new ValidationError(`Grant from 1 to ${String(GRANT_MAX_DAYS)} days, or no end date.`);
  }
  return { plan: input.plan, days };
}

/**
 * The derivation's changes with the plan change and state reason the grant really made: the derivation compares the
 * row it was given, which already carries the granted (or removed) plan.
 */
function fixChanges(
  changes: readonly BillingChange[],
  from: PlanId,
  to: PlanId,
  source: PlanSource,
  reason: StateReason | null,
): BillingChange[] {
  const out: BillingChange[] = changes
    .filter((c) => c.kind !== "plan_changed")
    .map((c): BillingChange => (c.kind === "state_changed" && reason !== null ? { ...c, reason } : c));
  if (from !== to) out.push({ kind: "plan_changed", from, to, source });
  return out;
}

/**
 * Applies a plan with no subscription behind it (a staff grant, a comp) or removes one, in the caller's unit of work
 * under the account lock: the next row is derived as the sync would (holds lifted when a lapsed account gets a plan
 * again; holds applied when a removed grant leaves more than Free allows) and the effects applied. Returns the audit
 * entries for the derived changes, to record with the person's own entry.
 */
async function applyGrant(
  deps: Deps,
  r: Repositories,
  accountId: string,
  current: AccountBilling,
  accountPlan: PlanId,
  next: Pick<AccountBilling, "planSource" | "paidPlan" | "compUntil">,
  reason: StateReason | null,
): Promise<AuditAlso[]> {
  const now = deps.clock.now();
  const seeded: AccountBilling = { ...current, ...next };
  const currentHolds = await r.billing.holds(accountId);
  const ending = next.planSource === "none";
  const resources = ending ? await holdResources(deps, r, accountId) : null;
  const holdCount = resources ? computeHolds(resources, now).holds.length : currentHolds.length;
  const disputes: BillingDispute[] = await r.billing.disputes(accountId);
  const d = deriveBilling(seeded, null, [], { now, holdCount, disputes });
  const changes = fixChanges(d.changes, effectivePlan(current), effectivePlan(d.next), d.next.planSource, reason);
  return applyDerivation(deps, r, {
    accountId,
    accountPlan,
    derivation: { ...d, changes },
    resources,
    currentHolds,
    now,
  });
}

/** Grants and comps never replace a live paid subscription (a subscription replaces a comp, not the reverse). */
const hasSubscription = (b: AccountBilling): boolean => hasLiveSubscription(b);

type StaffRefusal = "act_as" | "step_up_required" | "already_subscribed" | "not_granted";

const STAFF_ERRORS: Record<Exclude<StaffRefusal, "act_as" | "step_up_required">, () => BillingError> = {
  already_subscribed: () =>
    new BillingError("already_subscribed", "This account pays for its plan: a grant can't replace a subscription."),
  not_granted: () => new BillingError("not_subscribed", "This account has no plan granted by staff or a code."),
};

/** The platform-scoped spec, the account lookup (404, audited in the platform log) and the account's own spec. */
export async function staffAccount(
  deps: Deps,
  actor: Actor,
  accountId: string,
  req: RequestMeta,
  action: MutationSpec["action"],
): Promise<{ spec: MutationSpec; name: string; plan: PlanId }> {
  const base = { action, permission: "platform.billing.manage" } as const;
  const platformSpec: MutationSpec = { ...base, accountId: null, target: { type: "account_billing" } };
  await authorizeAudited(deps, actor, req, platformSpec);
  const account = isId(accountId) ? await deps.uow.run((r) => r.accounts.get(accountId)) : null;
  if (!account) {
    await mutation(deps, actor, req, platformSpec, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  return {
    spec: { ...base, accountId, target: { ...billingTarget(accountId), label: account.name }, staffPath: true },
    name: account.name,
    plan: account.plan,
  };
}

/** Staff never change billing while acting as someone; the change needs a fresh step-up (ADR-0028). */
export async function staffGate(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  session: BillingSession,
): Promise<void> {
  await refuseActAs(deps, actor, req, spec);
  await requireStepUp(deps, actor, req, spec, session);
}

const throwRefusal = (code: StaffRefusal | null): void => {
  if (code === "already_subscribed" || code === "not_granted") throw STAFF_ERRORS[code]();
};

/**
 * Staff (`platform.billing.manage` ★, Global and Billing Administrators): give an account Plus or Supporter without a
 * payment, for `days` (a comp that lapses at its end like any other) or with no end date (a staff grant). Not over a
 * live subscription (409 `already_subscribed`). A lapsed account gets everything held back at once. Fresh step-up;
 * never while acting as someone. Audited `billing.staff_plan_granted` by staff in the account's log (rule 49) with the
 * derived changes, and in the platform log.
 */
export async function grantStaffPlan(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { plan?: unknown; days?: unknown },
  session: BillingSession,
  req: RequestMeta,
): Promise<{ state: BillingState; plan: PlanId; until: Date | null }> {
  const { spec, plan: accountPlan } = await staffAccount(deps, actor, accountId, req, "billing.staff_plan_granted");
  const grant = parsePlanGrant(input);
  await staffGate(deps, actor, req, spec, session);
  const out = await mutation(
    deps,
    actor,
    req,
    spec,
    async (
      r,
    ): Promise<
      MutationOutcome<{ refused: StaffRefusal } | { state: BillingState; plan: PlanId; until: Date | null }>
    > => {
      await r.accounts.lock(accountId);
      const now = deps.clock.now();
      const current = await billingOf(r, accountId, now);
      if (!current) throw new NotFoundError();
      if (hasSubscription(current))
        return { result: { refused: "already_subscribed" }, denied: { code: "already_subscribed" } };
      const until = grant.days === null ? null : new Date(now.getTime() + grant.days * DAY_MS);
      const also = await applyGrant(
        deps,
        r,
        accountId,
        current,
        accountPlan,
        { planSource: until ? "comp" : "staff", paidPlan: grant.plan, compUntil: until },
        until ? "comp_started" : "staff_grant",
      );
      const meta = { plan: grant.plan, days: grant.days, until: until?.toISOString() ?? null };
      return {
        result: { state: "active", plan: grant.plan, until },
        meta,
        also,
        copies: [{ accountId: null, meta: { accountId, ...meta } }],
      };
    },
  );
  if ("refused" in out) {
    throwRefusal(out.refused);
    throw new Error("unreachable");
  }
  return out;
}

/**
 * Staff (`platform.billing.manage` ★): end a staff grant or a comp now. The account drops to Free, holding what
 * doesn't fit (never deleting). 409 `not_subscribed` when the plan isn't a grant or a comp. Fresh step-up; never while
 * acting as someone. Audited `billing.staff_plan_revoked` in the account's log (rule 49) and the platform log.
 */
export async function endStaffPlan(
  deps: Deps,
  actor: Actor,
  accountId: string,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ state: BillingState }> {
  const { spec, plan: accountPlan } = await staffAccount(deps, actor, accountId, req, "billing.staff_plan_revoked");
  await staffGate(deps, actor, req, spec, session);
  const out = await mutation(
    deps,
    actor,
    req,
    spec,
    async (r): Promise<MutationOutcome<{ refused: StaffRefusal } | { state: BillingState }>> => {
      await r.accounts.lock(accountId);
      const now = deps.clock.now();
      const current = await billingOf(r, accountId, now);
      if (!current) throw new NotFoundError();
      const granted = (current.planSource === "staff" || current.planSource === "comp") && current.state === "active";
      if (!granted) return { result: { refused: "not_granted" }, denied: { code: "not_subscribed" } };
      const also = await applyGrant(
        deps,
        r,
        accountId,
        current,
        accountPlan,
        { planSource: "none", paidPlan: null, compUntil: null },
        current.planSource === "comp" ? "comp_ended" : "subscription_ended",
      );
      const after = (await r.billing.get(accountId))?.state ?? "free";
      const meta = { fromPlan: current.paidPlan, source: current.planSource, toState: after };
      return { result: { state: after }, meta, also, copies: [{ accountId: null, meta: { accountId, ...meta } }] };
    },
  );
  if ("refused" in out) {
    throwRefusal(out.refused);
    throw new Error("unreachable");
  }
  return out;
}

/**
 * Applies a comp code's plan to an account (`billing.comp_redeemed`, ADR-0029 §8) inside the redemption's unit of work:
 * the account must be on Free or lapsed (a comp never replaces a paid plan). Returns the derived changes' entries.
 */
export async function applyCompInUnit(
  deps: Deps,
  r: Repositories,
  accountId: string,
  comp: { plan: PaidPlanId; days: number },
): Promise<{ until: Date; also: AuditAlso[] } | null> {
  const account = await r.accounts.get(accountId);
  if (!account) return null;
  await r.accounts.lock(accountId);
  const now = deps.clock.now();
  const current = await billingOf(r, accountId, now);
  if (!current || (current.state !== "free" && current.state !== "lapsed")) return null;
  const until = new Date(now.getTime() + comp.days * DAY_MS);
  const also = await applyGrant(
    deps,
    r,
    accountId,
    current,
    account.plan,
    { planSource: "comp", paidPlan: comp.plan, compUntil: until },
    "comp_started",
  );
  return { until, also };
}

/**
 * Staff (`platform.billing.manage` ★): refund the latest paid invoice of the account's subscription in full — outside
 * the 14-day window, an add-on charge, or an account that already had its self-service refund (ADR-0029 §9) — and,
 * when asked, end the subscription now (the sync then lapses the account, holding, never deleting). Refused while a
 * dispute is open (the issuer already returned the money) and for an invoice already refunded (409
 * `refund_not_eligible`). Fresh step-up; never while acting as someone. Audited `billing.refunded` with `staff: true` in
 * the account's log (rule 49) and the platform log; it doesn't use up the account's self-service refund.
 */
export async function staffRefund(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  input: { endSubscription?: unknown },
  session: BillingSession,
  req: RequestMeta,
): Promise<{ amountMinor: number; currency: string; ended: boolean }> {
  const { spec } = await staffAccount(deps, actor, accountId, req, "billing.refunded");
  const end = input.endSubscription === true;
  await refuseActAs(deps, actor, req, spec);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  await requireStepUp(deps, actor, req, spec, session);
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  if (!b) throw new NotFoundError();
  const notEligible = (message: string) =>
    refuse(deps, actor, req, spec, "refund_not_eligible", new BillingError("refund_not_eligible", message));
  const customerId = b.providerCustomerId;
  if (customerId === null) return notEligible("This account has never paid.");
  const sub = await callProvider(deps, actor, req, spec, () => provider.getSubscription(customerId));
  const inv = sub?.latestInvoice ?? null;
  if (sub === null || inv?.status !== "paid") return notEligible("There's no paid invoice on a live subscription.");
  if (sub.disputed || sub.disputeLost || b.disputedAt !== null) {
    return notEligible("This payment is disputed: the card issuer returns the money, so it isn't refunded here.");
  }
  if (inv.refundedMinor >= inv.amountMinor) return notEligible("That payment was already refunded.");
  const now = deps.clock.now();
  const withinWindow = refundEligibility(inv, now).eligible;
  const refunded = await callProvider(deps, actor, req, spec, () =>
    provider.refundInvoice({ invoiceId: inv.id, intentId: `refund:${inv.id}` }),
  );
  if (end) {
    await callProvider(deps, actor, req, spec, () =>
      provider.cancel({ subscriptionId: sub.subscriptionId, when: "now", intentId: `refund-cancel:${inv.id}` }),
    );
  }
  return mutation(deps, actor, req, spec, async (r) => {
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: deps.clock.now() });
    const meta = {
      invoiceId: inv.id,
      amountMinor: refunded.amountMinor,
      currency: refunded.currency,
      withinWindow,
      staff: true,
      ended: end,
    };
    return {
      result: { amountMinor: refunded.amountMinor, currency: refunded.currency, ended: end },
      meta,
      copies: [{ accountId: null, meta: { accountId, ...meta } }],
    };
  });
}

export type PlatformBillingView = {
  available: boolean;
  status: typeof BILLING.status;
  row: AccountBilling;
  plan: PlanId;
  entitled: { storageBlocks: number; extraMailboxes: number };
  disputes: BillingDispute[];
  /** Provider events received for the account and waiting for its sync. */
  queuedEvents: number;
  holds: number;
  addresses: number;
  /** The address ceiling in force and the configured one (staff only: never shown to customers). */
  ceiling: { effective: number; configured: number };
  /** What staff may do now (the server checks each again). */
  can: { grant: boolean; endGrant: boolean; refund: boolean; resync: boolean; clearDisputes: boolean };
};

/**
 * Staff (`platform.billing.manage`): the account's billing as staff need it on Platform → account (ADR-0029 §9):
 * state, provider ids, the last sync, disputes, events waiting, holds, the address ceiling and its override. A read:
 * the page around it is already audited (`staff.account_viewed`). Unknown account → 404, other staff → 403.
 */
export async function platformAccountBilling(
  deps: Deps,
  ctx: Pick<BillingContext, "provider">,
  actor: Actor,
  accountId: string,
): Promise<PlatformBillingView> {
  authorize(actor, "platform.billing.manage");
  if (!isId(accountId)) throw new NotFoundError();
  const now = deps.clock.now();
  return deps.uow.run(async (r) => {
    const account = await r.accounts.get(accountId);
    const row = await billingOf(r, accountId, now);
    if (!account || !row) throw new NotFoundError();
    // One query at a time: a unit of work holds one database connection.
    const disputes = await r.billing.disputes(accountId);
    const queued = await r.billing.pendingEvents(accountId);
    const holds = await r.billing.holds(accountId);
    const mailboxes = await r.mailboxes.count(accountId);
    const aliases = await r.aliases.listByAccount(accountId);
    const effective = await addressCeilingOf(deps, r, accountId);
    const e = entitlements(row);
    const live = hasLiveSubscription(row);
    return {
      available: ctx.provider !== null,
      status: BILLING.status,
      row,
      plan: account.plan,
      entitled: { storageBlocks: e.storageBlocks, extraMailboxes: e.extraMailboxes },
      disputes,
      queuedEvents: queued.length,
      holds: holds.length,
      addresses: mailboxes + aliases.length,
      ceiling: { effective, configured: deps.limits?.addressCeiling ?? DEV_ADDRESS_CEILING },
      can: {
        grant: !live,
        endGrant: (row.planSource === "staff" || row.planSource === "comp") && row.state === "active",
        refund: ctx.provider !== null && row.providerCustomerId !== null && live,
        resync: ctx.provider !== null && row.providerCustomerId !== null,
        clearDisputes:
          ctx.provider !== null && (row.disputedAt !== null || disputes.some((d) => isRestrictingDispute(d.status))),
      },
    };
  });
}

export type PlatformBillingSummary = {
  available: boolean;
  status: typeof BILLING.status;
  /** Accounts that need attention, oldest state change first (at most `limit` each). */
  lists: Record<
    "past_due" | "restricted" | "lapsed",
    { accountId: string; name: string; since: Date; disputed: boolean }[]
  >;
  /** Provider events no account could be matched to yet (kept until staff dismiss them). */
  orphans: { id: string; type: string; objectId: string; receivedAt: Date }[];
  /** The last check of the provider's catalogue against the plan facts (null before the first one). */
  catalogue: CatalogueStatus | null;
};

/**
 * Staff (`platform.billing.manage`): Platform billing (ADR-0029 §9): accounts past due, with sending paused (and why)
 * or lapsed, and provider events not matched to an account. Metadata only: no amounts, no payer details.
 */
export async function platformBillingSummary(
  deps: Deps,
  ctx: Pick<BillingContext, "provider">,
  actor: Actor,
  limit = 50,
): Promise<PlatformBillingSummary> {
  authorize(actor, "platform.billing.manage");
  return deps.uow.run(async (r) => {
    // One query at a time: a unit of work holds one database connection.
    const pastDue = await r.billing.listByState("past_due", limit);
    const restricted = await r.billing.listByState("restricted", limit);
    const lapsed = await r.billing.listByState("lapsed", limit);
    const orphans = await r.billing.listEvents("orphan", limit);
    const catalogue = await r.billing.catalogue();
    const names = await r.access.accountNames([...pastDue, ...restricted, ...lapsed].map((b) => b.accountId));
    const row = (b: AccountBilling) => ({
      accountId: b.accountId,
      name: names[b.accountId] ?? "Account",
      since: b.stateSince,
      disputed: b.disputedAt !== null,
    });
    return {
      available: ctx.provider !== null,
      status: BILLING.status,
      lists: { past_due: pastDue.map(row), restricted: restricted.map(row), lapsed: lapsed.map(row) },
      orphans: orphans.map((e) => ({ id: e.id, type: e.type, objectId: e.objectId, receivedAt: e.receivedAt })),
      catalogue,
    };
  });
}
