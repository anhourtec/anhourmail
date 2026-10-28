// SPDX-License-Identifier: AGPL-3.0-only
import { requirePlatformPermission } from "@/server/route-guard";

/** Customer accounts: staff without `platform.accounts.read` get a real 404, like customers. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePlatformPermission("platform.accounts.read");
  return children;
}
