// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";

/** Account pages share the console frame; the navigation shows this account's sections. */
export default async function AccountLayout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  const { accountId } = await params;
  return <ConsoleFrame accountId={accountId}>{children}</ConsoleFrame>;
}
