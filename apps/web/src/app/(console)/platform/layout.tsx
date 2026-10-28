// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";
import { requirePlatformPermission } from "@/server/route-guard";

/** Staff pages share the console frame. Everyone else gets a real 404 here, before the page streams. */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformPermission();
  return <ConsoleFrame>{children}</ConsoleFrame>;
}
