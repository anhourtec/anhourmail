// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `billing.sync`, `billing.resolve` and the nightly `billing.reconcile` (ADR-0029 §4). The provider's state is fetched,
 * never trusted from a webhook: the sync reads the account's live subscription (and its disputes) outside any lock,
 * then, in one unit of work under the account row lock, derives the next billing row (`deriveBilling`), writes it and
 * the effective plan, applies or lifts plan holds, queues the mail-server work and audits every change.
 *
 * A provider outage never restricts anyone: a retryable provider error throws before anything is written, so the queue
 * retries with backoff and our state stays as it was. Nothing here deletes mail (rule 26).
 */
import { BILLING } from "@anhourmail/shared/plans";

import { onPlatformDomain } from "../mailboxes/platform";
import { recordSystemChanges, type SystemChange } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { promoteForPayment, revokeBillingPromotion } from "../trust/service";

import type { AccountBilling, BillingEvent, PlanHold } from "./entity";
import { computeHolds, type HoldResources } from "./holds";
import {
  type BillingChange,
  defaultBilling,
  type Derivation,
  deriveBilling,
  effectivePlan,
  isPaidState,
  type PendingBillingEvent,
} from "./lifecycle";
import {
  type BillingProvider,
  BillingProviderError,
  DISPUTE_EVENT_TYPES,
  type DisputeOutcome,
  isLiveSubStatus,
  type ProviderSubscription,
} from "./ports";

const SYNC = { kind: "system", name: "billing-sync" } as const;
const DAY_MS = 86_400_000;
/** Accounts not synced for this long are synced by the nightly reconcile (a lost webhook heals within a day). */
export const SYNC_STALE_MS = DAY_MS;
/** Processed events are kept beyond the provider's three-day retry window, then pruned (orphans are kept). */
export const EVENT_RETENTION_MS = 35 * DAY_MS;

const reqOf = (id: string): RequestMeta => ({ requestId: id, ip: null, userAgent: null });

export type SyncOutcome =
  | { status: "synced"; changes: BillingChange[] }
  /** The account is gone (deleted meanwhile): nothing to do. */
  | { status: "no_account" }
  /** A provider answer we must not guess past (catalogue drift, two live subscriptions): audited, state unchanged. */
  | { status: "failed"; code: string };

/** What the sync needs to compute holds: the account's people, mailboxes, custom domains and aliases. */
export async function holdResources(deps: Deps, r: Repositories, accountId: string): Promise<HoldResources> {
  // One query at a time: a unit of work holds one database connection.
  const members = await r.access.members(accountId);
  const mailboxes = await r.mailboxes.listByAccount(accountId);
  const domains = await r.domains.listByAccount(accountId);
  const aliases = await r.aliases.listByAccount(accountId);
  return {
    ownerUserIds: members.filter((m) => m.role === "owner").map((m) => m.userId),
    mailboxes: mailboxes.map((m) => ({
      id: m.id,
      userId: m.userId,
      platform: onPlatformDomain(m.address, deps.platform),
      status: m.status,
      createdAt: m.createdAt,
    })),
    domainIds: domains.filter((d) => d.status !== "removing").map((d) => d.id),
    aliases: aliases.map((a) => ({
      id: a.id,
      mailboxId: a.mailboxId,
      kind: a.kind,
      enabled: a.enabled,
      platform: onPlatformDomain(a.address, deps.platform),
      createdAt: a.createdAt,
    })),
  };
}

/** A retryable provider error (outage, rate limit) propagates: the job retries and nothing is written. */
const retryable = (err: unknown): boolean => !(err instanceof BillingProviderError) || err.retryable;

async function fetchSubscription(
  provider: BillingProvider,
  b: AccountBilling,
): Promise<{ sub: ProviderSubscription | null } | { failed: string }> {
  if (b.providerCustomerId === null) return { sub: null };
  try {
    return { sub: await provider.getSubscription(b.providerCustomerId) };
  } catch (err) {
    if (retryable(err)) throw err;
    return { failed: (err as BillingProviderError).code };
  }
}

/**
 * Fresh outcomes for the disputes this sync touches: those its events name and every tracked one still open (so a
 * lost dispute-closed event heals on the next sync). An unknown dispute or a refused read leaves it out (its tracked
 * status, or `open`, stands: never lifted on a guess); an outage throws.
 */
async function readDisputes(provider: BillingProvider, ids: readonly string[]): Promise<Map<string, DisputeOutcome>> {
  const out = new Map<string, DisputeOutcome>();
  for (const id of new Set(ids)) {
    try {
      out.set(id, (await provider.getDispute(id)).status);
    } catch (err) {
      if (retryable(err)) throw err;
    }
  }
  return out;
}

const target = (accountId: string) => ({ type: "account_billing", id: accountId });

/** The audit entries for one derivation (meta never holds card details, addresses or payloads; provider ids are fine). */
function auditOf(accountId: string, next: AccountBilling, changes: readonly BillingChange[], held: HeldCounts | null) {
  const entry = (action: SystemChange["action"], meta: Record<string, unknown>): SystemChange => ({
    action,
    accountId,
    target: target(accountId),
    meta,
  });
  const currency = next.currency;
  return changes.flatMap((c): SystemChange[] => {
    switch (c.kind) {
      case "state_changed":
        // `to` is a redacted key (recipients), hence the longer names.
        return [entry("billing.state_changed", { fromState: c.from, toState: c.to, reason: c.reason })];
      case "plan_changed":
        return [entry("billing.plan_changed", { fromPlan: c.from, toPlan: c.to, source: c.source })];
      case "addons_changed":
        return [
          entry("billing.addons_changed", {
            storageBlocksFrom: c.storageBlocks.from,
            storageBlocksTo: c.storageBlocks.to,
            extraMailboxesFrom: c.extraMailboxes.from,
            extraMailboxesTo: c.extraMailboxes.to,
          }),
        ];
      case "supporter_amount_changed":
        return [entry("billing.supporter_amount_changed", { fromMinor: c.from, toMinor: c.to, currency })];
      case "payment_succeeded":
        return [entry("billing.payment_succeeded", { invoiceId: c.invoiceId, amountMinor: c.amountMinor, currency })];
      case "payment_failed":
        return [entry("billing.payment_failed", { invoiceId: c.invoiceId, amountMinor: c.amountMinor, currency })];
      case "cancel_scheduled":
        return [entry("billing.cancel_scheduled", { at: c.at.toISOString() })];
      case "cancel_undone":
        return [entry("billing.cancel_undone", {})];
      case "dispute_opened":
        return [entry("billing.dispute_opened", {})];
      case "dispute_closed":
        return [entry("billing.dispute_closed", { disputeId: c.disputeId, outcome: c.outcome })];
      case "refunded":
        // Made outside our console (the provider's dashboard); a console refund writes its own entry (slice 9).
        return [
          entry("billing.refunded", { objectId: c.objectId, amountMinor: c.amountMinor, currency, source: "provider" }),
        ];
      case "holds_needed":
        return held ? [entry("billing.holds_applied", { ...held })] : [];
      case "holds_lifted":
        return held ? [entry("billing.holds_lifted", { ...held })] : [];
    }
  });
}

type HeldCounts = { mailboxes: number; domains: number; aliases: number };
const countHolds = (holds: readonly { subjectType: string }[]): HeldCounts => ({
  mailboxes: holds.filter((h) => h.subjectType === "mailbox").length,
  domains: holds.filter((h) => h.subjectType === "domain").length,
  aliases: holds.filter((h) => h.subjectType === "alias").length,
});

/** Changes that alter what the mail server must allow (sending, receiving, catch-all, aliases). */
const touchesMailServer = (changes: readonly BillingChange[]): boolean =>
  changes.some(
    (c) =>
      c.kind === "holds_needed" ||
      c.kind === "holds_lifted" ||
      (c.kind === "state_changed" && (c.from === "restricted" || c.to === "restricted")),
  );

/**
 * Writes one derivation (`deriveBilling`) inside the caller's unit of work, under the account lock the caller holds:
 * the billing row and the effective plan, processed events and tracked disputes, plan holds applied (with pending
 * invites revoked) or lifted, and the mail-server work the change implies. Returns the audit entries for it; the
 * caller records them (the sync as the system, a staff grant or a code redemption with the person's own entry).
 * Shared by `billing.sync` and the changes made without the provider (staff grants, comps; ADR-0029 §8, §9).
 */
export async function applyDerivation(
  deps: Deps,
  r: Repositories,
  input: {
    accountId: string;
    /** `customer_account.plan` before this change. */
    accountPlan: string;
    derivation: Derivation;
    /** The account's resources when they were read for the hold count (read again when needed). */
    resources: HoldResources | null;
    currentHolds: readonly PlanHold[];
    now: Date;
  },
): Promise<SystemChange[]> {
  const { accountId, derivation: d, resources, currentHolds, now } = input;
  await r.billing.save(d.next);
  const plan = effectivePlan(d.next);
  if (input.accountPlan !== plan) await r.accounts.setPlan(accountId, plan);
  await r.billing.markEventsProcessed(accountId, d.processedEventIds, now);
  if (d.disputes.length > 0) await r.billing.saveDisputes(accountId, d.disputes);

  let held: HeldCounts | null = null;
  const revoked: SystemChange[] = [];
  if (d.changes.some((c) => c.kind === "holds_needed")) {
    const planned = computeHolds(resources ?? (await holdResources(deps, r, accountId)), now);
    await r.billing.replaceHolds(accountId, planned.holds, now);
    held = countHolds(planned.holds);
    // Free can't add people (ADR-0029 §6): pending invites are revoked; members stay members.
    for (const invite of await r.invites.listPending(accountId)) {
      if (await r.invites.revoke(invite.id)) {
        revoked.push({
          action: "account.invite_revoked",
          accountId,
          target: { type: "invite", id: invite.id },
          meta: { reason: "plan_lapsed" },
        });
      }
    }
  } else if (d.changes.some((c) => c.kind === "holds_lifted")) {
    held = countHolds(currentHolds);
    await r.billing.clearHolds(accountId);
  }

  if (touchesMailServer(d.changes)) {
    // Every mailbox's access follows the account's state and holds (`mailbox.ensure`); custom domains drop or regain
    // their catch-all with their holds (`domain.ensure`). Deleting mailboxes and removing domains have their own jobs.
    for (const m of await r.mailboxes.listByAccount(accountId)) {
      if (m.status !== "deleting") {
        await r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: now });
      }
    }
    if (held !== null) {
      for (const dom of await r.domains.listByAccount(accountId)) {
        if (dom.status === "active")
          await r.provisioning.enqueue({ kind: "domain.ensure", subjectId: dom.id, runAfter: now });
      }
    }
  }
  const tier = await tierAfterBilling(deps, r, accountId, d);
  return [...auditOf(accountId, d.next, d.changes, held), ...revoked, ...tier];
}

/**
 * What a derivation does to the trust tier (ADR-0034 §2; security review of slices 1–11, finding 2), in the same unit
 * of work under the account lock:
 * - **A dispute** (open or lost, `disputedAt` set): the account is marked restricted (`last_restricted_at`, from when it
 *   was first disputed, so nothing promotes it automatically again, whatever the dispute's outcome) and billing's
 *   promotion is taken back.
 * - **A refund** made at the provider (`charge.refunded`): billing's promotion is taken back. The console's refunds
 *   take it back themselves.
 * - **The paid plan ending** (a paid state to `free` or `lapsed`: a cancel, a lapse, a comp or grant ending) within the
 *   refund window of the promotion: taken back. A promotion older than that is kept (it stays when the plan ends).
 * - **Entering `active`, or a new payment while `active`:** a `new` account becomes `standard` (`promoteForPayment`).
 *   Only then, so a refund that leaves the subscription live isn't undone by the next sync.
 * Staff-set, automatic and restricted tiers are never touched either way.
 */
async function tierAfterBilling(
  deps: Deps,
  r: Repositories,
  accountId: string,
  d: Derivation,
): Promise<SystemChange[]> {
  if (d.next.disputedAt !== null) {
    await r.trust.markRestricted(accountId, d.next.disputedAt);
    return revokeBillingPromotion(deps, r, accountId, "dispute");
  }
  if (d.changes.some((c) => c.kind === "refunded")) return revokeBillingPromotion(deps, r, accountId, "refund");
  if (d.changes.some((c) => c.kind === "state_changed" && isPaidState(c.from) && !isPaidState(c.to))) {
    return revokeBillingPromotion(deps, r, accountId, "plan_ended", {
      withinMs: BILLING.refundWindowDays * DAY_MS,
    });
  }
  const paid = d.changes.some(
    (c) => (c.kind === "state_changed" && c.to === "active") || c.kind === "payment_succeeded",
  );
  return d.next.state === "active" && paid ? promoteForPayment(deps, r, accountId) : [];
}

const REFUND = { kind: "system", name: "billing-refund" } as const;

/**
 * A refund made in the console (the customer's self-service one or staff's) takes billing's promotion back at once,
 * inside the refund's unit of work under the account lock, recorded `trust.tier_changed` by the system (security
 * review of ADR-0034 slices 1–11, finding 2). The sync that follows finds nothing more to take back.
 */
export async function takePromotionForRefund(
  deps: Deps,
  r: Repositories,
  accountId: string,
  req: RequestMeta,
): Promise<void> {
  await recordSystemChanges(deps, r, REFUND, req, await revokeBillingPromotion(deps, r, accountId, "refund"));
}

/**
 * Syncs one account's billing with the provider (job `billing.sync`, subject = account id). Idempotent: a second run
 * with nothing new writes only `last_synced_at`. Events that arrive while it runs stay queued for the next run (their
 * own job is already queued by ingestion).
 */
export async function syncAccountBilling(
  deps: Deps,
  provider: BillingProvider,
  accountId: string,
  opts: {
    requestId?: string;
    /**
     * Runs first in the locked unit of work, before anything is written: the queue re-confirms its job claim here and
     * throws when another worker took the job over, so a stale run never writes over a newer one.
     */
    guard?: (r: Repositories) => Promise<void>;
  } = {},
): Promise<SyncOutcome> {
  const req = reqOf(opts.requestId ?? `billing-sync-${accountId}`);
  const before = await deps.uow.run(async (r) => {
    const account = await r.accounts.get(accountId);
    if (!account) return null;
    return {
      billing: (await r.billing.get(accountId)) ?? defaultBilling(accountId, account.plan, deps.clock.now()),
      pending: await r.billing.pendingEvents(accountId),
      disputes: await r.billing.disputes(accountId),
    };
  });
  if (!before) return { status: "no_account" };

  // Provider reads first, outside any lock and any transaction.
  const fetched = await fetchSubscription(provider, before.billing);
  if ("failed" in fetched) {
    await deps.uow.run((r) =>
      recordSystemChanges(deps, r, SYNC, req, [
        {
          action: "billing.sync_failed",
          accountId: null,
          target: target(accountId),
          meta: { accountId, error: fetched.failed },
        },
      ]),
    );
    return { status: "failed", code: fetched.failed };
  }
  const { sub } = fetched;
  const fresh = await readDisputes(provider, [
    ...before.pending.filter((e) => DISPUTE_EVENT_TYPES.includes(e.type)).map((e) => e.objectId),
    ...before.disputes.filter((d) => d.status === "open").map((d) => d.disputeId),
  ]);
  const seen = new Set(before.pending.map((e) => e.id));
  const customerAtFetch = before.billing.providerCustomerId;

  return deps.uow.run(async (r): Promise<SyncOutcome> => {
    await opts.guard?.(r);
    await r.accounts.lock(accountId);
    const account = await r.accounts.get(accountId);
    if (!account) return { status: "no_account" };
    const now = deps.clock.now();
    const previous = (await r.billing.get(accountId)) ?? defaultBilling(accountId, account.plan, now);
    // A checkout gave the account a provider customer while we fetched: what we read is for the old one. Retry.
    if (previous.providerCustomerId !== customerAtFetch) throw new Error("billing customer changed while syncing");
    const events: PendingBillingEvent[] = (await r.billing.pendingEvents(accountId))
      .filter((e: BillingEvent) => seen.has(e.id))
      .map((e) => ({
        id: e.id,
        type: e.type,
        objectId: e.objectId,
        providerCreatedAt: e.providerCreatedAt,
        ...(e.type === "charge.dispute.closed" ? { disputeOutcome: fresh.get(e.objectId) ?? null } : {}),
      }));
    const disputes = await r.billing.disputes(accountId);
    const currentHolds = await r.billing.holds(accountId);
    // Holds only matter when the paid plan may end here (no live subscription): reading the account's resources is
    // skipped for every paying account.
    const mayEnd = sub === null || !isLiveSubStatus(sub.status) || sub.status === "incomplete";
    const resources = mayEnd ? await holdResources(deps, r, accountId) : null;
    const holdCount =
      previous.state === "lapsed" ? currentHolds.length : resources ? computeHolds(resources, now).holds.length : 0;
    const d = deriveBilling(previous, sub, events, { now, holdCount, disputes, disputeStatuses: fresh });

    const entries = await applyDerivation(deps, r, {
      accountId,
      accountPlan: account.plan,
      derivation: d,
      resources,
      currentHolds,
      now,
    });
    await recordSystemChanges(deps, r, SYNC, req, entries);
    return { status: "synced", changes: d.changes };
  });
}

export type ResolveOutcome = "adopted" | "unresolved" | "skipped";

/**
 * `billing.resolve` (subject = a `billing_event` orphan): a dispute names only its payment, so the provider is asked
 * whose it is. When its customer maps to one of our accounts, the event is attached and that account's sync queued;
 * otherwise it stays an orphan for the next attempt (the nightly reconcile) and for staff. The metadata hint is never
 * used. An outage throws (the queue retries).
 */
export async function resolveOrphanEvent(
  deps: Deps,
  provider: BillingProvider,
  eventId: string,
): Promise<ResolveOutcome> {
  const event = await deps.uow.run((r) => r.billing.getEvent(eventId));
  if (event?.status !== "orphan" || !DISPUTE_EVENT_TYPES.includes(event.type)) return "skipped";
  let customerId: string | null;
  try {
    customerId = (await provider.getDispute(event.objectId)).customerId;
  } catch (err) {
    if (retryable(err)) throw err;
    return "unresolved";
  }
  if (customerId === null) return "unresolved";
  return deps.uow.run(async (r) => {
    const owner = await r.billing.byCustomerId(customerId);
    if (!owner) return "unresolved";
    if (!(await r.billing.adoptOrphan(event.id, owner.accountId))) return "skipped";
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: owner.accountId, runAfter: deps.clock.now() });
    return "adopted";
  });
}

export type ReconcileRun = { syncsQueued: number; orphansAdopted: number; orphansLeft: number; pruned: number };

/**
 * `billing.reconcile` (nightly, scheduler): queues a sync for every account with a provider customer not synced for a
 * day (a lost webhook heals), retries resolving dispute orphans, and prunes processed events past the retention. One
 * orphan that can't be resolved (or an outage) never stops the rest.
 */
export async function reconcileBilling(
  deps: Deps,
  provider: BillingProvider,
  opts: { batch?: number } = {},
): Promise<ReconcileRun> {
  const batch = opts.batch ?? 500;
  const now = deps.clock.now();
  const run: ReconcileRun = { syncsQueued: 0, orphansAdopted: 0, orphansLeft: 0, pruned: 0 };
  const orphans = (await deps.uow.run((r) => r.billing.listEvents("orphan", batch))).filter((e) =>
    DISPUTE_EVENT_TYPES.includes(e.type),
  );
  for (const o of orphans) {
    const outcome = await resolveOrphanEvent(deps, provider, o.id).catch(() => "unresolved" as const);
    if (outcome === "adopted") run.orphansAdopted++;
    else if (outcome === "unresolved") run.orphansLeft++;
  }
  await deps.uow.run(async (r) => {
    for (const accountId of await r.billing.dueForSync(new Date(now.getTime() - SYNC_STALE_MS), batch)) {
      await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: now });
      run.syncsQueued++;
    }
    run.pruned = await r.billing.pruneEvents(new Date(now.getTime() - EVENT_RETENTION_MS));
  });
  return run;
}
