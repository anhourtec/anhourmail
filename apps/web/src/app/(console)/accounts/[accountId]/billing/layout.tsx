// SPDX-License-Identifier: AGPL-3.0-only
import { requireAccountSection } from "@/server/route-guard";

/** Billing: a role without `billing.read` (Domain and User Administrators, Members) gets the 403 page, outsiders 404. */
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  await requireAccountSection((await params).accountId, "billing.read");
  return children;
}
