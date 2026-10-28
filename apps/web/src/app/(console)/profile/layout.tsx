// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";

/** The person's own Profile page, in the console frame. */
export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame>{children}</ConsoleFrame>;
}
