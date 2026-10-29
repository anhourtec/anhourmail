// SPDX-License-Identifier: AGPL-3.0-only
import { requirePlatformPermission } from "@/server/route-guard";

/** Pending account deletions: staff without `platform.deletions.read` get a real 404, like customers. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePlatformPermission("platform.deletions.read");
  return children;
}
