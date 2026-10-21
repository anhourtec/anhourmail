// SPDX-License-Identifier: AGPL-3.0-only
import { cookies } from "next/headers";

import { type ChromeNavGroup, ConsoleChrome } from "./console-chrome";
import { GROUPS_COOKIE, SIDEBAR_COOKIE } from "./sidebar-cookies";
import { SignOutButton } from "./sign-out-button";
import { ThemeToggle } from "./theme-toggle";

export type ShellNavGroup = ChromeNavGroup;

/**
 * Full-width console frame: sidebar navigation derived from the permission matrix (console-nav.ts), expandable or
 * compact (remembered in a cookie, read here so the first paint has the right width), and the content area.
 */
export async function ConsoleShell({
  email,
  groups,
  children,
}: {
  email: string;
  groups: ShellNavGroup[];
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const compact = jar.get(SIDEBAR_COOKIE)?.value === "compact";
  // Next has already decoded the value; ids not in the person's own groups are ignored.
  const closed = (jar.get(GROUPS_COOKIE)?.value ?? "").split(",").filter((id) => groups.some((g) => g.id === id));
  return (
    <ConsoleChrome
      groups={groups}
      email={email}
      initialCompact={compact}
      initialClosed={closed}
      actions={
        <>
          <ThemeToggle />
          <SignOutButton />
        </>
      }
    >
      {children}
    </ConsoleChrome>
  );
}
