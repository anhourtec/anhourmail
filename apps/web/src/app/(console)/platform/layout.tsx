// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";

/** Staff pages share the console frame. Each page checks its own permission and is a 404 for everyone else. */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame>{children}</ConsoleFrame>;
}
