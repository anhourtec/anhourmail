// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing when an account is deleted (ADR-0029 §9 "Account deletion", ADR-0025). Asking to delete the account sets its
 * subscription to end at the period's end (no renewal while it waits out the grace period); when removal starts, the
 * subscription is ended now (no refund unless the Owner took one). Our billing rows go with the account row; the
 * provider's customer and its invoices stay with the provider (tax records), and the audit log stays (append-only).
 *
 * Provider first, then our unit of work (the sync queued here records what the provider then reports). A provider
 * failure changes nothing and is answered `failed`: on request the hourly `billing.timers` tries again, and removal
 * doesn't start until the subscription is ended, so a deleted account is never left paying.
 */
import { recordSystemChanges } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { billingOf, hasLiveSubscription } from "./checkout";
import { billingTarget } from "./guards";
import { type BillingProvider, BillingProviderError, isLiveSubStatus, type ProviderSubscription } from "./ports";

const EXECUTOR = { kind: "system", name: "account-deletion" } as const;
const HOUR_MS = 3_600_000;

/**
 * - `none`: nothing to cancel (never paid, no live subscription, or only a grant or comp, which end with the account);
 * - `already`: the subscription already ends at the period's end;
 * - `scheduled` / `ended`: cancelled at the period's end / now, audited;
 * - `failed`: the provider couldn't be asked or refused (or billing is off while our row says the account pays).
 */
export type DeletionBillingOutcome = "none" | "already" | "scheduled" | "ended" | "failed";

/**
 * Cancels the account's live subscription for its deletion: at the period's end when the deletion is asked for (and by
 * `billing.timers` while it waits), now when removal starts, its open invoices voided first. `deleteAfter` identifies
 * the deletion: the request's idempotency intent is the deletion itself (a retried request never makes a second call);
 * a timers retry (`retry`) has its own intent per hour, so a replay of the request's cached answer can't stand in for
 * it after the cancellation was undone outside our console (review run-69 N1). Success is audited only when a fresh
 * read of the subscription shows the cancellation; otherwise the call counts as `failed` and is tried again.
 */
export async function cancelBillingForDeletion(
  deps: Deps,
  provider: BillingProvider | null,
  accountId: string,
  when: "period_end" | "now",
  deletion: { deleteAfter: Date },
  opts: { retry?: boolean } = {},
): Promise<DeletionBillingOutcome> {
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  const customerId = b?.providerCustomerId ?? null;
  if (!b || customerId === null) return "none";
  if (!provider) return hasLiveSubscription(b) ? "failed" : "none";
  let sub: ProviderSubscription | null;
  try {
    sub = await provider.getSubscription(customerId);
  } catch (err) {
    if (err instanceof BillingProviderError) return "failed";
    throw err;
  }
  // `incomplete` (a first payment never confirmed) grants nothing and expires by itself; ended now all the same.
  if (sub === null || !isLiveSubStatus(sub.status) || (when === "period_end" && sub.status === "incomplete")) {
    return "none";
  }
  if (when === "period_end" && sub.cancelAt !== null) return "already";
  const subscriptionId = sub.subscriptionId;
  const stamp = String(deletion.deleteAfter.getTime());
  const intentId =
    when === "now"
      ? `account-deletion-start:${accountId}:${stamp}`
      : opts.retry === true
        ? `account-deletion-retry:${accountId}:${stamp}:${String(Math.floor(deps.clock.now().getTime() / HOUR_MS))}`
        : `account-deletion:${accountId}:${stamp}`;
  let after: ProviderSubscription | null;
  try {
    await provider.cancel({ subscriptionId, when, intentId, ...(when === "now" ? { voidOpenInvoices: true } : {}) });
    after = await provider.getSubscription(customerId);
  } catch (err) {
    if (err instanceof BillingProviderError) return "failed";
    throw err;
  }
  // What the provider now says, not what the call answered (an idempotent replay answers as before).
  const took =
    when === "now"
      ? !(after?.subscriptionId === subscriptionId && isLiveSubStatus(after.status))
      : after?.subscriptionId === subscriptionId && after.cancelAt !== null;
  if (!took) return "failed";
  const now = deps.clock.now();
  const req: RequestMeta = { requestId: `deletion-billing-${when}-${accountId}`, ip: null, userAgent: null };
  await deps.uow.run(async (r) => {
    if (!(await r.accounts.get(accountId))) return;
    await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: now });
    await recordSystemChanges(deps, r, EXECUTOR, req, [
      when === "now"
        ? {
            action: "billing.subscription_ended",
            accountId,
            target: billingTarget(accountId),
            meta: { reason: "account_deletion", subscriptionId },
          }
        : {
            action: "billing.cancel_scheduled",
            accountId,
            target: billingTarget(accountId),
            meta: { reason: "account_deletion", at: sub.currentPeriodEnd.toISOString(), subscriptionId },
          },
    ]);
  });
  return when === "now" ? "ended" : "scheduled";
}
