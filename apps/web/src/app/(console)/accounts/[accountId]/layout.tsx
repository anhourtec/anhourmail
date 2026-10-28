// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";
import { requireAccountMember } from "@/server/route-guard";

/**
 * Account pages share the console frame; the navigation shows this account's sections. Someone outside the account
 * gets a real 404 here, before the page streams.
 */
export default async function AccountLayout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  const { accountId } = await params;
  await requireAccountMember(accountId);
  return <ConsoleFrame accountId={accountId}>{children}</ConsoleFrame>;
}
