// SPDX-License-Identifier: AGPL-3.0-only
import { PLANS, type PlanId } from "@anhourmail/shared";

/** Mailboxes the demo adds to the Family account besides its people: one suspended, one being deleted. */
export const FAMILY_LIFECYCLE_MAILBOXES = 2;

/**
 * Each demo mailbox's share of its account's storage pool: the pool split evenly over the plan's included
 * mailboxes, in whole GB, at least 1 GB (1 GB on every plan today). A full demo account then stays inside its pool,
 * as the console's own defaults would (`defaultShareBytes`).
 */
export function demoQuotaBytes(plan: PlanId): number {
  const p = PLANS[plan];
  return Math.max(1, Math.floor(p.storagePoolGb / p.includedMailboxes)) * 1024 ** 3;
}
