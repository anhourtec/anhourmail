// SPDX-License-Identifier: AGPL-3.0-only
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

/**
 * Records a contacts import from the webmail (ADR-0030 §10, §14) in the mailbox's account log: written as the mailbox
 * itself (a `system` actor named by its address, as `data.mail_exported` is), with the file's format and the counts
 * only — never names, addresses or anything else from the cards (rule 24). An unknown address records nothing.
 */
export async function recordContactsImport(
  deps: Deps,
  address: string,
  info: {
    format: "vcard" | "csv";
    created: number;
    merged: number;
    duplicates: number;
    invalid: number;
    overCap: number;
  },
  req: RequestMeta,
): Promise<void> {
  const m = await deps.uow.run((r) => r.webmailSettings.mailboxByAddress(address.trim().toLowerCase()));
  if (!m) return;
  // Exactly these keys, whatever else the caller's object carries.
  const meta = {
    format: info.format,
    created: info.created,
    merged: info.merged,
    duplicates: info.duplicates,
    invalid: info.invalid,
    overCap: info.overCap,
  };
  await mutation(
    deps,
    { kind: "system", name: m.address },
    req,
    {
      action: "data.contacts_imported",
      permission: "mailbox.read",
      accountId: m.accountId,
      target: { type: "mailbox", id: m.id, label: m.address },
    },
    async () => ({ result: undefined, meta }),
  );
}
