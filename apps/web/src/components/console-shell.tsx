// SPDX-License-Identifier: AGPL-3.0-only
import { cookies } from "next/headers";

import { can, type UserActor } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import { listDomains } from "@anhourmail/core/domains";
import { listMailboxes } from "@anhourmail/core/mailboxes";
import { listPeople } from "@anhourmail/core/people";
import { accountSuspensionNotice } from "@anhourmail/core/platform";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { navTree } from "@/server/console-nav";
import { container } from "@/server/container";
import { env } from "@/server/env";

import type { MenuAccount } from "./account-menu";
import { ConsoleChrome } from "./console-chrome";
import { AccountSuspendedNotice } from "./console/account-suspended-notice";
import type { NavCounts, PrimaryAction } from "./console/left-nav";
import { SIDEBAR_COOKIE } from "./sidebar-cookies";

/**
 * Counts beside the navigation rows, from the services with the person's own permissions (so they never reveal
 * more than the pages would): mailboxes, aliases, domains, and pending invites (emphasised: someone has to act).
 */
async function navCounts(actor: UserActor, accountId: string | undefined): Promise<NavCounts> {
  if (!accountId) return {};
  const deps = container().deps;
  const [mailboxes, aliases, domains, people] = await Promise.all([
    can(actor, "mailbox.read", accountId) ? listMailboxes(deps, actor, accountId) : null,
    can(actor, "alias.manage.own", accountId) ? listAliases(deps, actor, accountId) : null,
    can(actor, "domain.read", accountId) ? listDomains(deps, actor, accountId) : null,
    can(actor, "member.read", accountId) ? listPeople(deps, actor, accountId) : null,
  ]);
  return {
    ...(mailboxes ? { "mailbox.read": { count: mailboxes.length } } : {}),
    ...(aliases ? { "alias.manage.own": { count: aliases.aliases.length } } : {}),
    ...(domains ? { "domain.read": { count: domains.length } } : {}),
    ...(people ? { "member.read": { count: people.invites.filter((i) => !i.expired).length, emphasis: true } } : {}),
  };
}

/** The sidebar's prominent button: the most common create action this person's role allows. */
function primaryAction(actor: UserActor, accountId: string | undefined): PrimaryAction | null {
  const base = accountId ? `/accounts/${accountId}` : "";
  if (accountId && can(actor, "mailbox.manage", accountId))
    return { label: "New mailbox", href: `${base}/mailboxes?new=1`, icon: "mailbox" };
  if (accountId && can(actor, "member.manage", accountId))
    return { label: "New invite", href: `${base}/people?new=1`, icon: "person" };
  if (accountId && can(actor, "alias.manage.own", accountId))
    return { label: "New alias", href: `${base}/aliases?new=1`, icon: "alias" };
  if (can(actor, "platform.accounts.read"))
    return { label: "Find an account", href: "/platform/accounts", icon: "account" };
  return null;
}

/**
 * Full console frame: app bar, left navigation derived from the permission matrix (console-nav.ts) for the current
 * account — the one in the URL, else the person's first — with counts and the role's main action, and the content.
 * The navigation width comes from a cookie so the server renders the first paint right. The person's menu lists their own
 * accounts only, each opening its first page they can see.
 */
export async function ConsoleShell({
  actor,
  names,
  accountId,
  children,
}: {
  actor: UserActor;
  names: Record<string, string>;
  /** The account the page belongs to, if any. */
  accountId?: string;
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const compact = jar.get(SIDEBAR_COOKIE)?.value === "compact";
  const current =
    accountId && actor.memberships.some((m) => m.accountId === accountId) ? accountId : actor.memberships[0]?.accountId;
  const accounts: MenuAccount[] = actor.memberships.map((m) => ({
    id: m.accountId,
    name: names[m.accountId] ?? "Account",
    role: ROLE_LABELS[`account:${m.role}`],
    href:
      navTree(actor, m.accountId)
        .filter((s) => s.id !== "platform")
        .flatMap((s) => s.items)
        .find((i) => i.href)?.href ?? "/",
  }));
  const staffRole = actor.platformRoles[0];
  // A suspended account (staff, `platform.account.suspend`): its people see the notice instead of its pages.
  const suspendedNotice =
    current && actor.suspendedAccountIds?.includes(current)
      ? await accountSuspensionNotice(container().deps, actor, current)
      : null;
  return (
    <ConsoleChrome
      tree={navTree(actor, current)}
      counts={await navCounts(actor, current)}
      primary={primaryAction(actor, current)}
      currentAccountId={current ?? null}
      user={{
        name: actor.name ?? "",
        email: actor.email,
        staffRole: staffRole ? ROLE_LABELS[`platform:${staffRole}`] : null,
        // Customers only (roles.md "Mail (webmail link)": staff ✗). Pre-fills the address, never a credential.
        ...(actor.memberships.length > 0
          ? {
              webmailHref: `${env().WEBMAIL_URL.replace(/\/$/, "")}/sign-in?address=${encodeURIComponent(actor.email)}`,
            }
          : {}),
      }}
      accounts={accounts}
      siteUrl={env().SITE_URL.replace(/\/$/, "")}
      orgName={current ? (names[current] ?? "Account") : actor.platformRoles.length > 0 ? "Anhourtec staff" : null}
      staff={actor.platformRoles.length > 0}
      initialCompact={compact}
    >
      {current && suspendedNotice ? (
        <>
          <AccountSuspendedNotice
            accountName={names[current] ?? "Account"}
            reasonLabel={suspendedNotice.reasonLabel}
            since={suspendedNotice.since}
          />
          {/* The account's own pages are closed; pages that aren't the account's (Security, home) stay below. */}
          {accountId === current ? null : children}
        </>
      ) : (
        children
      )}
    </ConsoleChrome>
  );
}
