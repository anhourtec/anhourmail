// SPDX-License-Identifier: AGPL-3.0-only
import { requireAccountSection } from "@/server/route-guard";

/** Account settings (export, deletion): Owners only; any other role gets the 403 page, outsiders the 404. */
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  await requireAccountSection((await params).accountId, "account.export");
  return children;
}
