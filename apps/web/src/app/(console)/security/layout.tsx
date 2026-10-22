// SPDX-License-Identifier: AGPL-3.0-only
import { ConsoleFrame } from "@/server/console-frame";

/** The Security page stays reachable while an account requirement is unmet: it's where people meet it. */
export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame enrolling>{children}</ConsoleFrame>;
}
