// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The billing banner above every console page of an account (ADR-0029 §9): what the people in it need to know when a
 * payment failed, sending is paused or the paid plan ended. Who sees what:
 *
 * - `past_due` (the provider is retrying a renewal; nothing changes yet): people who see billing (`billing.read`).
 * - `restricted` (sending paused): everyone in the account, because their own sending stopped; people who can't fix it
 *   are told who can.
 * - `lapsed` (the paid plan ended, some things are held): everyone, since held mailboxes can't send; the Owner and
 *   Billing Administrators get "Choose what stays on".
 *
 * A read for any member of the account; anyone else gets no banner (never an error: it decorates every page).
 */
import { BILLING } from "@anhourmail/shared/plans";

import { type Actor, can } from "../actor";
import type { Deps } from "../ports";

import { billingOf } from "./checkout";

const DAY_MS = 86_400_000;

export type BillingNotice = {
  state: "past_due" | "restricted" | "lapsed";
  since: Date;
  /** Why sending is paused: the payment (retries ran out, or paused) or a dispute with the card issuer. */
  reason: "payment" | "dispute" | null;
  /**
   * Restricted for a payment: when the subscription ends (and the account drops to Free with holds) unless it is paid.
   * Null for a dispute (staff handle those) and in the other states.
   */
  endsAt: Date | null;
  /** The person sees the Billing page. */
  canRead: boolean;
  /** The person can fix it (`billing.manage`; never while staff act as someone, which is read-only). */
  canManage: boolean;
};

export async function accountBillingNotice(deps: Deps, actor: Actor, accountId: string): Promise<BillingNotice | null> {
  if (actor.kind !== "user" || !actor.memberships.some((m) => m.accountId === accountId)) return null;
  const b = await deps.uow.run((r) => billingOf(r, accountId, deps.clock.now()));
  if (!b || (b.state !== "past_due" && b.state !== "restricted" && b.state !== "lapsed")) return null;
  const canRead = can(actor, "billing.read", accountId);
  const canManage = actor.actingAs === undefined && can(actor, "billing.manage", accountId);
  if (b.state === "past_due" && !canRead) return null;
  const dispute = b.state === "restricted" && b.disputedAt !== null;
  return {
    state: b.state,
    since: b.stateSince,
    reason: b.state === "restricted" ? (dispute ? "dispute" : "payment") : null,
    endsAt:
      b.state === "restricted" && !dispute && b.restrictedAt !== null
        ? new Date(b.restrictedAt.getTime() + BILLING.restrictedDays * DAY_MS)
        : null,
    canRead,
    canManage,
  };
}
