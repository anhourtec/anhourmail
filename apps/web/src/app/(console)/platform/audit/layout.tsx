// SPDX-License-Identifier: AGPL-3.0-only
import { requirePlatformPermission } from "@/server/route-guard";

/** The platform audit log: staff without `platform.audit.read` get a real 404, like customers. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePlatformPermission("platform.audit.read");
  return children;
}
