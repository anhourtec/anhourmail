// SPDX-License-Identifier: AGPL-3.0-only
import { requireAccountSection } from "@/server/route-guard";

/** Import mail: a role without `mailbox.import.own` gets the 403 page (a real status, before the page streams). */
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  await requireAccountSection((await params).accountId, "mailbox.import.own");
  return children;
}
