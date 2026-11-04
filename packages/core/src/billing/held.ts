// SPDX-License-Identifier: AGPL-3.0-only
/**
 * New addresses never land on what a downgrade held (ADR-0029 §6, security review run-60 SA60-01). A held custom domain
 * stays active (its holds live in `plan_hold`), and a new alias or mailbox on it would be synced to the mail server as
 * an ordinary address, giving a Free account custom-domain mail indefinitely. So every path that attaches an address
 * to a domain or a mailbox refuses: a custom domain while the effective plan has none, a held domain, and a held
 * mailbox. 403 `plan_limit`, audited as denied (the house code for what the plan doesn't include).
 */
import { PLANS } from "@anhourmail/shared/plans";

import { NotFoundError, PlanLimitError } from "../errors";
import type { Repositories } from "../ports";

function heldRefusal(message: string): PlanLimitError {
  const e = new PlanLimitError(message);
  e.auditDenied = true;
  return e;
}

/** A new address on this custom domain is allowed: the effective plan includes custom domains and it isn't held. */
export async function assertDomainUsable(
  repos: Repositories,
  accountId: string,
  domain: { id: string; name: string },
): Promise<void> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const plan = PLANS[account.plan];
  if (!plan.customDomains) {
    throw heldRefusal(
      `${plan.name} doesn't include custom domains. ${domain.name} stays on your account, but new addresses on it need a paid plan.`,
    );
  }
  if ((await repos.billing.heldIds(accountId, "domain", [domain.id])).length > 0) {
    throw heldRefusal(`${domain.name} is held since the paid plan ended: resubscribe to add addresses on it.`);
  }
}

/** A new alias may point at this mailbox: it isn't held after a downgrade. */
export async function assertMailboxNotHeld(repos: Repositories, accountId: string, mailboxId: string): Promise<void> {
  if ((await repos.billing.heldIds(accountId, "mailbox", [mailboxId])).length > 0) {
    throw heldRefusal(
      "This mailbox is held since the paid plan ended: it can't get new aliases until you resubscribe.",
    );
  }
}
