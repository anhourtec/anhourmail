// SPDX-License-Identifier: AGPL-3.0-only
import { requireAccountSection } from "@/server/route-guard";

/** Domains: a role without `domain.read` gets the 403 page (a real status, before the page streams). */
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  await requireAccountSection((await params).accountId, "domain.read");
  return children;
}
