// SPDX-License-Identifier: AGPL-3.0-only
import { cookies } from "next/headers";

import type { UserActor } from "@anhourmail/core";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { env } from "@/server/env";

import type { MenuAccount } from "./account-menu";
import { type ChromeNavGroup, ConsoleChrome } from "./console-chrome";
import { GROUPS_COOKIE, SIDEBAR_COOKIE } from "./sidebar-cookies";

export type ShellNavGroup = ChromeNavGroup;

/**
 * Full-width console frame: sidebar navigation derived from the permission matrix (console-nav.ts), expandable or
 * compact (remembered in a cookie, read here so the first paint has the right width), and the content area. The
 * person's menu lists their own accounts only, each opening its first page they can see.
 */
export async function ConsoleShell({
  actor,
  groups,
  children,
}: {
  actor: UserActor;
  groups: ShellNavGroup[];
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const compact = jar.get(SIDEBAR_COOKIE)?.value === "compact";
  // Next has already decoded the value; ids not in the person's own groups are ignored.
  const closed = (jar.get(GROUPS_COOKIE)?.value ?? "").split(",").filter((id) => groups.some((g) => g.id === id));
  const accounts: MenuAccount[] = actor.memberships.map((m) => {
    const group = groups.find((g) => g.id === m.accountId);
    return {
      id: m.accountId,
      name: group?.title ?? "Account",
      role: ROLE_LABELS[`account:${m.role}`],
      href: group?.items.find((i) => i.href && !i.href.startsWith("/#"))?.href ?? "/",
    };
  });
  const staffRole = actor.platformRoles[0];
  return (
    <ConsoleChrome
      groups={groups}
      user={{
        name: actor.name ?? "",
        email: actor.email,
        staffRole: staffRole ? ROLE_LABELS[`platform:${staffRole}`] : null,
      }}
      accounts={accounts}
      siteUrl={env().SITE_URL.replace(/\/$/, "")}
      initialCompact={compact}
      initialClosed={closed}
    >
      {children}
    </ConsoleChrome>
  );
}
