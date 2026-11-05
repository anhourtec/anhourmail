// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The control plane's own sending check for billing (ADR-0029 §5, rule 27): a `restricted` account's mailboxes and a
 * mailbox held after a lapse can't send. The mail server refuses them too (`SEND_BLOCKED_PERMISSIONS`, applied by
 * `mailbox.ensure`); this lets the webmail refuse before it submits, with a message that says why and who can fix it
 * (`403 billing_restricted`), and holds in the moments before the worker has applied the new state. Read-only: it
 * changes nothing, so it writes no audit entry.
 */
import type { Deps } from "../ports";

/** Why billing stops a mailbox sending: the account's payment problem, or the mailbox held after the plan ended. */
export type BillingSendBlock = "restricted" | "held";

/** The billing reason this mailbox (by address) can't send now, or null (it may, or we don't hold the address). */
export async function billingSendBlock(deps: Deps, address: string): Promise<BillingSendBlock | null> {
  const key = address.trim().toLowerCase();
  if (key === "" || key.length > 254) return null;
  return deps.uow.run(async (r) => {
    const m = await r.webmailSettings.mailboxByAddress(key);
    if (!m) return null;
    // One query at a time: a unit of work holds one database connection.
    const held = await r.billing.heldIds(m.accountId, "mailbox", [m.id]);
    if (held.length > 0) return "held";
    return (await r.billing.get(m.accountId))?.state === "restricted" ? "restricted" : null;
  });
}
