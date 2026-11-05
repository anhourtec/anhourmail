// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Platform billing actions that complete slice 12 (ADR-0029 §9): clearing an account's disputes, re-syncing an
 * account with the provider now, and dismissing a provider event no account could be matched to. Staff only
 * (`platform.billing.manage` ★: Global and Billing Administrators), never while acting as someone (ADR-0023). Clearing
 * and dismissing change what the account or the platform keeps, so they need a fresh step-up (ADR-0028); a re-sync
 * only asks the provider for the truth the nightly reconcile would read anyway, so it doesn't. Account actions are
 * audited in the account's own log as staff (rule 49) with a copy in the platform log; an orphan belongs to no
 * account, so its dismissal is in the platform log only.
 */
import type { Actor } from "../actor";
import { NotFoundError, ValidationError } from "../errors";
import { authorizeAudited, mutation, type MutationOutcome, type MutationSpec } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { billingOf } from "./checkout";
import { type BillingDispute, isRestrictingDispute } from "./entity";
import { BillingError } from "./entitlements";
import {
  type BillingContext,
  type BillingSession,
  callProvider,
  refuseActAs,
  requireProvider,
  requireStepUp,
} from "./guards";
import { staffAccount, staffGate } from "./grants";

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * Staff: clear every dispute that keeps the account's sending paused (ADR-0029 §5: "dispute won or staff clears") —
 * the open and lost ones we track, and any the provider reports on the latest payment that we don't track yet. Cleared
 * disputes never restrict again, whatever the provider later says about them; a new dispute still does. The account's
 * state itself follows from the sync queued here (back to what the subscription says, usually Active). Needs the
 * provider (503 `billing_unavailable` while billing is off) for the latest payment's disputes; 409 `not_disputed` when
 * nothing is disputed. Only what staff saw is cleared (review run-69 N2): `disputeIds` are the disputes the panel
 * showed, and when the open or lost set differs now (one arrived, or one closed, since the page loaded) nothing is
 * cleared: 409 `changed`, audited. Fresh step-up; never while acting as someone. Audited `billing.dispute_closed` with
 * outcome `cleared` and `staff: true`.
 */

/** At most this many dispute ids in one request (a typo guard; an account has a handful at most). */
const MAX_DISPUTE_IDS = 100;

/** The dispute ids the panel showed: a list of provider ids (400 otherwise). */
export function parseDisputeIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_DISPUTE_IDS ||
    !input.every((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 255)
  ) {
    throw new ValidationError("Send the dispute ids shown on the page.");
  }
  return [...new Set(input)];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
export async function clearDisputes(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  input: { disputeIds?: unknown },
  session: BillingSession,
  req: RequestMeta,
): Promise<{ cleared: number }> {
  const { spec } = await staffAccount(deps, actor, accountId, req, "billing.dispute_closed");
  const shown = parseDisputeIds(input.disputeIds);
  await staffGate(deps, actor, req, spec, session);
  const provider = await requireProvider(deps, actor, req, spec, ctx);
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  if (!b) throw new NotFoundError();
  const customerId = b.providerCustomerId;
  // Provider first, outside any lock: the disputes it reports on the latest payment, by id.
  const sub =
    customerId === null ? null : await callProvider(deps, actor, req, spec, () => provider.getSubscription(customerId));
  const reported = (sub?.latestDisputes ?? [])
    .filter((d) => d.status === "open" || d.status === "lost")
    .map((d) => d.id);

  const out = await mutation(
    deps,
    actor,
    req,
    spec,
    async (r): Promise<MutationOutcome<{ cleared: number } | "not_disputed" | "changed">> => {
      await r.accounts.lock(accountId);
      const now = deps.clock.now();
      const current = await billingOf(r, accountId, now);
      if (!current) throw new NotFoundError();
      const tracked = await r.billing.disputes(accountId);
      const known = new Set(tracked.map((d) => d.disputeId));
      const rows: BillingDispute[] = [
        ...tracked
          .filter((d) => isRestrictingDispute(d.status))
          .map((d) => ({ ...d, status: "cleared" as const, closedAt: now, updatedAt: now })),
        ...reported
          .filter((id) => !known.has(id))
          .map((disputeId) => ({
            accountId,
            disputeId,
            status: "cleared" as const,
            openedAt: now,
            closedAt: now,
            updatedAt: now,
          })),
      ];
      if (rows.length === 0 && current.disputedAt === null) {
        return { result: "not_disputed", denied: { code: "not_disputed" } };
      }
      const nowIds = rows.map((d) => d.disputeId);
      if (!sameSet(nowIds, shown)) {
        return {
          result: "changed",
          meta: { shown: shown.length, now: nowIds.length },
          denied: { code: "changed" },
        };
      }
      if (rows.length > 0) await r.billing.saveDisputes(accountId, rows);
      await r.billing.save({ ...current, disputedAt: null, updatedAt: now });
      await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: now });
      const meta = {
        outcome: "cleared",
        staff: true,
        cleared: rows.length,
        disputeIds: rows.map((d) => d.disputeId),
        state: current.state,
      };
      return {
        result: { cleared: rows.length },
        meta,
        copies: [{ accountId: null, meta: { accountId, ...meta } }],
      };
    },
  );
  if (out === "not_disputed") throw new BillingError("not_disputed", "Nothing on this account is disputed.");
  if (out === "changed") {
    throw new BillingError(
      "changed",
      "The account's disputes changed since the page loaded. Reload and check them again.",
    );
  }
  return out;
}

/**
 * Staff: sync the account with the provider now instead of waiting for its next event or the nightly reconcile (a
 * `billing.sync` job, coalesced with one already queued). Changes nothing by itself: what the sync then finds is
 * audited by the sync. Needs the provider (503 while billing is off); never while acting as someone. Audited
 * `billing.resynced` as staff in the account's log and the platform log.
 */
export async function resyncAccountBilling(
  deps: Deps,
  ctx: BillingContext,
  actor: Actor,
  accountId: string,
  req: RequestMeta,
): Promise<{ queued: true }> {
  const { spec } = await staffAccount(deps, actor, accountId, req, "billing.resynced");
  await refuseActAs(deps, actor, req, spec);
  await requireProvider(deps, actor, req, spec, ctx);
  return mutation(deps, actor, req, spec, async (r) => {
    const now = deps.clock.now();
    const b = await billingOf(r, accountId, now);
    if (!b) throw new NotFoundError();
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: now });
    const meta = { state: b.state, lastSyncedAt: b.lastSyncedAt?.toISOString() ?? null };
    return { result: { queued: true as const }, meta, copies: [{ accountId: null, meta: { accountId, ...meta } }] };
  });
}

/**
 * Staff: dismiss a provider event that no account could be matched to (an orphan, ADR-0029 §4): it leaves the Platform
 * billing list and is pruned with processed events. Only orphans (404 otherwise, also for unknown ids). Fresh step-up;
 * never while acting as someone. Audited `billing.orphan_dismissed` in the platform log (the event has no account).
 */
export async function dismissBillingOrphan(
  deps: Deps,
  actor: Actor,
  eventId: string,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ dismissed: true }> {
  const spec: MutationSpec = {
    action: "billing.orphan_dismissed",
    permission: "platform.billing.manage",
    accountId: null,
    target: { type: "billing_event", id: isId(eventId) ? eventId : null },
  };
  await authorizeAudited(deps, actor, req, spec);
  const event = isId(eventId) ? await deps.uow.run((r) => r.billing.getEvent(eventId)) : null;
  if (event?.status !== "orphan") {
    await mutation(deps, actor, req, spec, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  await refuseActAs(deps, actor, req, spec);
  await requireStepUp(deps, actor, req, spec, session);
  const out = await mutation(deps, actor, req, spec, async (r): Promise<MutationOutcome<boolean>> => {
    const meta = { type: event.type, objectId: event.objectId, receivedAt: event.receivedAt.toISOString() };
    if (!(await r.billing.dismissOrphan(event.id, deps.clock.now()))) {
      return { result: false, meta, denied: { code: "not_found" } };
    }
    return { result: true, meta };
  });
  if (!out) throw new NotFoundError();
  return { dismissed: true };
}
