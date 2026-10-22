// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

/** Old domain address: the details now open as a panel over the list (`?domain=<id>`). */
export default async function DomainPage({ params }: { params: Promise<{ accountId: string; domainId: string }> }) {
  const { accountId, domainId } = await params;
  redirect(`/accounts/${encodeURIComponent(accountId)}/domains?domain=${encodeURIComponent(domainId)}`);
}
