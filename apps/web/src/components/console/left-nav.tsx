// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { EllipsisVertical, House, type LucideIcon, Mail, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import type { NavTreeSection } from "@/server/console-nav";

import { AccountMenu, type MenuAccount, type MenuUser } from "../account-menu";
import { PanelSurface, usePopover } from "../popover";
import {
  SidebarFooter,
  SidebarFrame,
  SidebarIdentity,
  SidebarNavItem,
  SidebarPrimaryAction,
  SidebarSection,
  SidebarTile,
} from "../sidebar/app-sidebar";
import { Tooltip } from "../tooltip";
import { NAV_ICONS } from "./nav-icons";

function isCurrent(pathname: string, href: string, exact = false): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Per-row counts from real data (permission-scoped on the server); `emphasis` for things waiting on someone. */
export type NavCounts = Partial<Record<string, { count: number; emphasis?: boolean }>>;

/** The most common create action for the person's role, shown as the sidebar's prominent button. */
/** The sidebar's main action; with `disabledReason` (and no `href`) it is shown disabled with that reason. */
export type PrimaryAction = {
  label: string;
  icon: "mailbox" | "person" | "alias" | "account";
} & ({ href: string; disabledReason?: undefined } | { href?: undefined; disabledReason: string });

/** The account menu's width (w-72) plus the panel surface's padding and border. */
const MENU_WIDTH = 302;

/** The ⋮ menu (and the tile in the rail): the person's menu — accounts, docs, webmail, sign out. */
function PersonMenu({
  user,
  accounts,
  siteUrl,
  trigger,
}: {
  user: MenuUser;
  accounts: MenuAccount[];
  siteUrl: string;
  trigger?: React.ReactNode;
}) {
  const { open, toggle, close, trigger: ref, panel } = usePopover();
  // Placed against the viewport, not the narrow sidebar: anchored under the trigger and clamped so the whole menu
  // stays on screen (the ⋮ sits near the sidebar's right edge, closer to the screen edge than the menu is wide).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const want = trigger ? r.left : r.right - MENU_WIDTH;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(want, window.innerWidth - MENU_WIDTH - 8)) });
  };
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      close(false);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);
  return (
    <div className="relative">
      <Tooltip label="Accounts and you" disabled={open}>
        <button
          ref={ref}
          type="button"
          aria-label="Accounts and you"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            place();
            toggle();
          }}
          className={
            trigger
              ? "rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
              : "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-sidebar-accent"
          }
        >
          {trigger ?? <EllipsisVertical className="size-4" aria-hidden />}
        </button>
      </Tooltip>
      {open && (
        <div ref={panel} className="fixed z-50" style={pos ?? undefined}>
          <PanelSurface>
            <AccountMenu
              user={user}
              accounts={accounts}
              siteUrl={siteUrl}
              onNavigate={() => {
                close(false);
              }}
            />
          </PanelSurface>
        </div>
      )}
    </div>
  );
}

/**
 * The console's left navigation, in the same design as the webmail sidebar (shared pieces in
 * components/sidebar/app-sidebar.tsx): the person's accounts as tiles with a ⋮ menu, their name and email, one
 * prominent action for their role, Home, then sections from the permission matrix with muted labels and counts,
 * and help, keyboard shortcuts, theme and sign out at the foot. An icon rail when collapsed; a drawer on small
 * screens.
 */
export function LeftNav({
  tree,
  counts,
  primary,
  user,
  accounts,
  currentAccountId,
  siteUrl,
  compact,
  mobile,
  onClose,
  onShortcuts,
  onSignOut,
}: {
  tree: NavTreeSection[];
  counts: NavCounts;
  primary: PrimaryAction | null;
  user: MenuUser;
  accounts: MenuAccount[];
  currentAccountId: string | null;
  siteUrl: string;
  compact: boolean;
  mobile: boolean;
  onClose?: () => void;
  onShortcuts: () => void;
  onSignOut: () => void;
}) {
  const pathname = usePathname();
  const current = accounts.find((a) => a.id === currentAccountId) ?? null;
  const tileText = current?.name ?? (user.staffRole ? "Anhourtec" : user.name || user.email);
  const PrimaryIcon: LucideIcon =
    primary?.icon === "person"
      ? NAV_ICONS.users
      : primary?.icon === "alias"
        ? NAV_ICONS["at-sign"]
        : primary?.icon === "account"
          ? NAV_ICONS.building
          : NAV_ICONS.inbox;

  return (
    <SidebarFrame>
      {mobile && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute top-2.5 right-2 z-10 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
      <SidebarIdentity
        collapsed={compact}
        tiles={
          accounts.length > 0 ? (
            accounts.map((a) => (
              <Tooltip key={a.id} label={`${a.name} · ${a.role}`}>
                <Link
                  href={a.href}
                  aria-label={a.name}
                  aria-current={a.id === currentAccountId ? "true" : undefined}
                  className="rounded-md focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <SidebarTile text={a.name} active={a.id === currentAccountId} />
                </Link>
              </Tooltip>
            ))
          ) : (
            <SidebarTile text={tileText} active />
          )
        }
        menu={<PersonMenu user={user} accounts={accounts} siteUrl={siteUrl} />}
        railMenu={
          <PersonMenu
            user={user}
            accounts={accounts}
            siteUrl={siteUrl}
            trigger={<SidebarTile text={tileText} active />}
          />
        }
        name={user.name || user.email}
        detail={current ? `${current.name} · ${current.role}` : (user.staffRole ?? user.email)}
      >
        {primary && (
          <SidebarPrimaryAction
            label={primary.label}
            icon={PrimaryIcon}
            collapsed={compact}
            {...(primary.href ? { href: primary.href } : { disabledReason: primary.disabledReason })}
          />
        )}
      </SidebarIdentity>

      <nav
        aria-label="Console"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onClick={(e) => {
          // In the drawer, following a link closes it.
          if (mobile && (e.target as HTMLElement).closest("a")) onClose?.();
        }}
      >
        <ul className="flex flex-col gap-0.5 pt-1">
          <li data-nav="home">
            <SidebarNavItem
              icon={House}
              label="Home"
              collapsed={compact}
              href="/"
              current={isCurrent(pathname, "/", true)}
            />
          </li>
          {tree.map((section, i) => (
            <li key={section.id}>
              {/* Billing and the audit log share one "Account" label; Mail, People and Platform have their own. */}
              {(section.group || tree[i - 1]?.group !== false) && (
                <SidebarSection label={section.group ? section.label : "Account"} collapsed={compact} />
              )}
              <ul aria-label={section.label} className="flex flex-col gap-0.5">
                {section.items.map((n) => {
                  const c = counts[n.permission];
                  return (
                    <li key={n.permission} data-nav={n.permission}>
                      <SidebarNavItem
                        icon={NAV_ICONS[n.icon]}
                        label={n.label}
                        collapsed={compact}
                        count={c?.count ?? 0}
                        emphasis={c?.emphasis ?? false}
                        {...(n.href ? { href: n.href, current: isCurrent(pathname, n.href) } : { soon: true })}
                      />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {user.webmailHref && (
            <li>
              <SidebarSection label="Mail apps" collapsed={compact} />
              <SidebarNavItem icon={Mail} label="Open webmail" collapsed={compact} href={user.webmailHref} />
            </li>
          )}
        </ul>
      </nav>

      <SidebarFooter collapsed={compact} helpHref={`${siteUrl}/docs`} onShortcuts={onShortcuts} onSignOut={onSignOut} />
    </SidebarFrame>
  );
}
