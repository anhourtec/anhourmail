// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the mail server should hold for a mailbox's sending now (ADR-0034 §4), read in the caller's unit of work: the
 * same inputs `mailbox.ensure` applies — billing's state and the plan hold on this mailbox, the account's tier and
 * staff's restriction of the mailbox — through `mailboxSendAccess`. Suspension is the caller's (it is compared on its
 * own). The reconciler compares this with the server (`accessMismatch`).
 */
import { billingMailboxAccess } from "../billing/lifecycle";
import type { Repositories } from "../ports";

import { mailboxRelayHold, mailboxSendAccess, type MailboxSendAccess } from "./access";

/** Whether the mailbox belongs on the relay hold now (`mailboxRelayHold`), read as `mailbox.ensure` reads it. */
export async function desiredRelayHold(r: Repositories, accountId: string, mailboxId: string): Promise<boolean> {
  const accountTier = (await r.trust.get(accountId))?.tier ?? "new";
  const mailboxRestricted = (await r.trust.mailbox(accountId, mailboxId))?.restriction != null;
  return mailboxRelayHold(accountTier, mailboxRestricted);
}

export async function desiredSendAccess(
  r: Repositories,
  accountId: string,
  mailboxId: string,
  now: Date,
): Promise<MailboxSendAccess> {
  const billingState = (await r.billing.get(accountId))?.state ?? "free";
  const hold =
    (await r.billing.holds(accountId)).find((h) => h.subjectType === "mailbox" && h.subjectId === mailboxId) ?? null;
  // As `mailbox.ensure`: an account that can't be read takes the default tier.
  const accountTier = (await r.trust.get(accountId))?.tier ?? "new";
  const mailboxRestricted = (await r.trust.mailbox(accountId, mailboxId))?.restriction != null;
  return mailboxSendAccess({
    suspended: false,
    billing: billingMailboxAccess(billingState, hold, now),
    accountTier,
    mailboxRestricted,
  });
}
