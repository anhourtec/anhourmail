// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

/** Old mailbox address: the details now open as a panel over the list (`?mailbox=<id>`). */
export default async function MailboxPage({ params }: { params: Promise<{ accountId: string; mailboxId: string }> }) {
  const { accountId, mailboxId } = await params;
  redirect(`/accounts/${encodeURIComponent(accountId)}/mailboxes?mailbox=${encodeURIComponent(mailboxId)}`);
}
