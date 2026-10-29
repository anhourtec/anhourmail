// SPDX-License-Identifier: AGPL-3.0-only
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

/**
 * Records a mail export from the webmail (ADR-0025) in the mailbox's account log: written as the mailbox itself (a
 * `system` actor named by its address, as for other webmail changes), with counts only — never folder names, subjects
 * or anything else about the mail (rule 24). An unknown address records nothing.
 */
export async function recordMailExport(
  deps: Deps,
  address: string,
  info: {
    scope: "all" | "folder";
    folders: number;
    messages: number;
    skipped: number;
    contacts: number;
    complete: boolean;
  },
  req: RequestMeta,
): Promise<void> {
  const m = await deps.uow.run((r) => r.webmailSettings.mailboxByAddress(address.trim().toLowerCase()));
  if (!m) return;
  await mutation(
    deps,
    { kind: "system", name: m.address },
    req,
    {
      action: "data.mail_exported",
      permission: "mailbox.read",
      accountId: m.accountId,
      target: { type: "mailbox", id: m.id, label: m.address },
    },
    async () => ({ result: undefined, meta: { ...info } }),
  );
}
