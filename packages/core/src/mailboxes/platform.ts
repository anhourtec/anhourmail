// SPDX-License-Identifier: AGPL-3.0-only
import { platformLocalPartProblem } from "@anhourmail/shared/addresses";
import { MAX_MAILBOXES, PLANS } from "@anhourmail/shared/plans";
import { COMPANY_DOMAIN, type Platform } from "@anhourmail/shared/platform";

import { type Actor, authorize } from "../actor";
import { ForbiddenError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import type { Deps, Repositories } from "../ports";

/**
 * Free addresses on the platform domain (`name@<PLATFORM_DOMAIN>`, ADR-0021). The platform domain belongs to no
 * account: it is configuration (`deps.platform.domain`), never a `customer_domain` row (customers can't add it, so the
 * domain, DNS and catch-all screens never show it), and the mail server's system domain already exists. Any account
 * may hold mailboxes on it: Free up to `PLANS.free.platformMailboxes`, paid plans within `MAX_MAILBOXES`. Names follow
 * the shared platform rules (4–32 characters, reserved names) and are first come, first served across all accounts; a
 * name that was in use is never handed to a different account (`PlatformAddressRepository`).
 */

/** What the create form sends as `domainId` for the platform domain (it has no row, so no uuid). */
export const PLATFORM_DOMAIN_ID = "platform";

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Whether an address is on this deployment's platform domain (where the free-address rules apply). */
export const onPlatformDomain = (address: string, platform: Pick<Platform, "domain">): boolean =>
  domainOf(address.toLowerCase()) === platform.domain;

/**
 * The platform domain must never be the company's staff domain (rule 28: `anhourtec.com` is staff-only); a
 * deployment configured that way gets no free addresses at all.
 */
export function assertCustomerPlatform(platform: Pick<Platform, "domain">): void {
  if (platform.domain === COMPANY_DOMAIN || platform.domain.endsWith(`.${COMPANY_DOMAIN}`)) {
    throw new ValidationError("Free addresses aren't available on this deployment.");
  }
}

/** A platform-domain local part from untrusted input, by the shared rules (trimmed, lowercased). */
export function normalisePlatformLocalPart(input: unknown): string {
  const v = typeof input === "string" ? input.trim().toLowerCase() : "";
  const problem = platformLocalPartProblem(v);
  if (problem) throw new ValidationError(problem);
  return v;
}

/**
 * Whether `address` (on the platform domain) can go to `accountId`: no mailbox or alias anywhere uses it, and it was
 * never retired from a different account. Callers hold `lockAddress` first when they are about to insert.
 */
export async function platformAddressFree(repos: Repositories, address: string, accountId: string): Promise<boolean> {
  // Both look-ups every time (no early return), so "in use" and "retired" take the same path and time.
  const taken = await repos.mailboxes.addressTaken(address);
  const retiredFrom = await repos.platformAddresses.retiredFrom(address);
  return !taken && (retiredFrom === null || retiredFrom === accountId);
}

/** The account's platform-domain mailboxes (every status: a deleting one still holds its address and its place). */
export async function platformMailboxCount(repos: Repositories, platform: Platform, accountId: string) {
  return (await repos.mailboxes.listByAccount(accountId)).filter((m) => onPlatformDomain(m.address, platform)).length;
}

/** How many more platform-domain mailboxes the account may create, by its plan and the mailbox ceiling. */
export async function platformAllowance(
  repos: Repositories,
  platform: Platform,
  accountId: string,
): Promise<{ used: number; max: number | null; remaining: number }> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const max = PLANS[account.plan].platformMailboxes;
  const used = await platformMailboxCount(repos, platform, accountId);
  const total = MAX_MAILBOXES - (await repos.mailboxes.count(accountId));
  return { used, max, remaining: Math.max(0, Math.min(total, max === null ? total : max - used)) };
}

/** Refuses a new platform-domain mailbox over the plan's allowance (checked under the account lock). */
export async function assertPlatformAllowance(repos: Repositories, platform: Platform, accountId: string) {
  const { max, remaining } = await platformAllowance(repos, platform, accountId);
  if (remaining > 0) return;
  if (max !== null && (await platformMailboxCount(repos, platform, accountId)) >= max) {
    throw new PlanLimitError(
      max === 1
        ? `This plan includes one free @${platform.domain} address.`
        : `This plan includes ${String(max)} free @${platform.domain} addresses.`,
    );
  }
  throw new PlanLimitError(`An account can have up to ${String(MAX_MAILBOXES)} mailboxes.`);
}

export type PlatformAddressCheck = {
  /** The full address checked (lowercased), or null when the name doesn't follow the rules. */
  address: string | null;
  available: boolean;
  /** Why the name can't be used as typed (format or reserved), in words a person can act on; null otherwise. */
  problem: string | null;
};

/**
 * Live availability check for the "Get your free address" form (`mailbox.manage`; 404 for other accounts). Only for a
 * caller who could claim one (confirmed email, allowance left; otherwise 403 with one generic message). It answers
 * only "available" or "not available" for a well-formed name — never whether it is a mailbox, an alias, retired or in
 * which account — and the route rate-limits it, so it can't be used to list who has which name. A read: not audited.
 */
export async function checkPlatformAddress(
  deps: Deps,
  actor: Actor,
  accountId: string,
  localPart: unknown,
): Promise<PlatformAddressCheck> {
  authorize(actor, "mailbox.manage", accountId);
  assertCustomerPlatform(deps.platform);
  // Only someone who could claim a name may ask about names: a confirmed email and room in the plan's allowance.
  // Otherwise one refusal that says nothing about the name asked (403).
  const allowed = await deps.uow.run(
    async (r) =>
      actor.kind === "user" &&
      (await r.access.emailVerified(actor.userId)) &&
      (await platformAllowance(r, deps.platform, accountId)).remaining > 0,
  );
  if (!allowed) throw new ForbiddenError(CHECK_REFUSED);
  const raw = typeof localPart === "string" ? localPart : "";
  const problem = platformLocalPartProblem(raw);
  if (problem) return { address: null, available: false, problem };
  const address = `${raw.trim().toLowerCase()}@${deps.platform.domain}`;
  const available = await deps.uow.run((r) => platformAddressFree(r, address, accountId));
  return { address, available, problem: null };
}

/** The one answer for a check from someone who can't claim a free address right now (unconfirmed email or no room). */
export const CHECK_REFUSED =
  "Names can be checked once your email is confirmed and your plan has room for a free address.";
