// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account ceilings the create services enforce under the account row lock (ADR-0029 §7): the add-on mailboxes in force
 * and the account-wide address ceiling. The address ceiling is an abuse limit from configuration, never published
 * (rule 33); support raises it per account (`setAddressCeilingOverride`).
 */
import { BILLING, mailboxCeiling, type PlanId, peopleCeiling } from "@anhourmail/shared/plans";

import { NotFoundError } from "../errors";
import type { Deps, Repositories } from "../ports";

import { BillingError, entitledAddons } from "./entitlements";
import { defaultBilling } from "./lifecycle";

/**
 * Used only when no limit is configured: development, tests and tools. Production refuses to start without
 * `ACCOUNT_ADDRESS_CEILING` (its value lives in the private ops repository).
 */
export const DEV_ADDRESS_CEILING = 5000;

/** The add-ons in force for the account (none outside the paid states; capacity paid for stays to period end). */
export async function entitledAddonsOf(
  repos: Repositories,
  accountId: string,
  plan: PlanId,
): Promise<{ storageBlocks: number; extraMailboxes: number }> {
  const b = (await repos.billing.get(accountId)) ?? defaultBilling(accountId, plan, new Date(0));
  return entitledAddons(b);
}

/**
 * Mailboxes and people the account may have now: the plan's included mailboxes plus the extra mailboxes in force, and
 * the people ceiling that follows it (ADR-0029 §7). `plan` is the effective plan (`customer_account.plan`).
 */
export async function accountCeilingsOf(
  repos: Repositories,
  accountId: string,
): Promise<{ plan: PlanId; mailboxes: number; people: number }> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const { extraMailboxes } = await entitledAddonsOf(repos, accountId, account.plan);
  return {
    plan: account.plan,
    mailboxes: mailboxCeiling(account.plan, extraMailboxes),
    people: peopleCeiling(account.plan, extraMailboxes),
  };
}

/** The refusal when the account has as many mailboxes as it may (403 `plan_limit`, as before billing). */
export const mailboxCeilingMessage = (ceiling: number): string =>
  BILLING.status === "open"
    ? `This account can have ${String(ceiling)} mailboxes. Add extra mailboxes on the Billing page.`
    : `Your plan includes ${String(ceiling)} mailboxes. More mailboxes come with billing, which isn't open yet.`;

/** The account's address ceiling: the staff override, else the configured one. */
export async function addressCeilingOf(deps: Deps, repos: Repositories, accountId: string): Promise<number> {
  const override = (await repos.billing.get(accountId))?.addressCeilingOverride ?? null;
  return override ?? deps.limits?.addressCeiling ?? DEV_ADDRESS_CEILING;
}

/**
 * Whether adding `adding` more addresses would take the account past its ceiling. Every mailbox, alias and masked alias
 * counts, whatever its state (a deleting, suspended, disabled or held one still holds its address). Call under the
 * account lock; a failed read throws, so the create fails closed.
 */
export async function addressCeilingReached(
  deps: Deps,
  repos: Repositories,
  accountId: string,
  adding = 1,
): Promise<boolean> {
  const used =
    (await repos.mailboxes.count(accountId)) +
    (await repos.aliases.count(accountId, "alias")) +
    (await repos.aliases.count(accountId, "masked"));
  return used + adding > (await addressCeilingOf(deps, repos, accountId));
}

/**
 * 409 `address_ceiling`: says only that there is a ceiling and who raises it (never the number). Audited as `denied`
 * (a policy refusal), like the other limits.
 */
export function addressCeilingError(): BillingError {
  const e = new BillingError(
    "address_ceiling",
    "This account has reached the most addresses it can hold. Delete one, or contact support to raise the limit.",
  );
  e.auditDenied = true;
  return e;
}
