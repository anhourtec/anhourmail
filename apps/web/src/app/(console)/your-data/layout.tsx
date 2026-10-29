// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";

/** The person's own data (export, delete their login), in the console frame. */
export default function YourDataLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame>{children}</ConsoleFrame>;
}
