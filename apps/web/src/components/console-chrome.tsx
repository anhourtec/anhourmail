// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  AtSign,
  Building2,
  ChevronDown,
  CreditCard,
  FileClock,
  Globe,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ScrollText,
  ShieldAlert,
  UserCog,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { NavIcon } from "@/server/console-nav";

import { AccountMenu, Avatar, type MenuAccount, type MenuUser } from "./account-menu";
import { BrandMark } from "./brand-mark";
import { HeaderActions } from "./header-actions";
import { PanelSurface, usePopover } from "./popover";
import { GROUPS_COOKIE, SIDEBAR_COOKIE, writeSidebarCookie } from "./sidebar-cookies";

export type ChromeNavItem = { label: string; permission: string; icon: NavIcon; href?: string };
export type ChromeNavGroup = { id: string; title: string; kind: "platform" | "account"; items: ChromeNavItem[] };

const ICONS: Record<NavIcon, LucideIcon> = {
  globe: Globe,
  inbox: Inbox,
  "at-sign": AtSign,
  users: Users,
  "credit-card": CreditCard,
  "scroll-text": ScrollText,
  building: Building2,
  "shield-alert": ShieldAlert,
  receipt: Receipt,
  "file-clock": FileClock,
  "user-cog": UserCog,
};

function isCurrent(pathname: string, href: string, exact: boolean): boolean {
  if (href.includes("#")) return false;
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Label shown beside the compact rail on hover/focus; fixed-positioned so the scrolling rail can't clip it. */
type Tip = { text: string; top: number } | null;

type Person = { user: MenuUser; accounts: MenuAccount[]; siteUrl: string };

/**
 * Foot of the sidebar: a short help card (expanded only) and the person's button, which opens their menu beside
 * the sidebar (above it in the drawer).
 */
function SidebarFooter({ person, compact, mobile }: { person: Person; compact: boolean; mobile: boolean }) {
  const { open: menuOpen, toggle: menuToggle, close: menuClose, trigger: menuTrigger, panel: menuPanel } = usePopover();
  const { user } = person;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border p-3">
      {!compact && (
        <div className="rounded-xl border bg-card px-3.5 py-3">
          <p className="font-medium text-[13px]">Need a hand?</p>
          <p className="am-micro mt-1">
            Read the{" "}
            <a href={`${person.siteUrl}/docs`} className="text-foreground underline underline-offset-2">
              guides
            </a>{" "}
            or{" "}
            <a href={`${person.siteUrl}/support`} className="text-foreground underline underline-offset-2">
              contact support
            </a>
            .
          </p>
        </div>
      )}
      <div className="relative">
        <button
          ref={menuTrigger}
          type="button"
          onClick={menuToggle}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={compact ? `Your account (${user.email})` : undefined}
          className={`flex w-full items-center rounded-lg transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-sidebar-accent ${compact ? "justify-center p-1" : "gap-3 p-2 text-left"}`}
        >
          <Avatar name={user.name} email={user.email} />
          {!compact && (
            <>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium text-[14px]">{user.name || user.email}</span>
                <span className="am-micro truncate">{user.email}</span>
              </span>
              <MoreVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </>
          )}
        </button>
        {menuOpen && (
          <div
            ref={menuPanel}
            className={
              mobile
                ? "absolute bottom-full left-0 mb-2"
                : `fixed bottom-3 ${compact ? "left-[4.5rem]" : "left-[16.5rem]"}`
            }
          >
            <PanelSurface>
              <AccountMenu
                user={person.user}
                accounts={person.accounts}
                siteUrl={person.siteUrl}
                onNavigate={() => {
                  menuClose(false);
                }}
              />
            </PanelSurface>
          </div>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  groups,
  person,
  compact,
  mobile,
  closed,
  onToggleGroup,
  onClose,
}: {
  groups: ChromeNavGroup[];
  person: Person;
  compact: boolean;
  mobile: boolean;
  closed: string[];
  onToggleGroup: (id: string) => void;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const [tip, setTip] = useState<Tip>(null);
  const toggleGroup = onToggleGroup;

  const tipProps = (text: string) =>
    compact
      ? {
          onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTip({ text, top: r.top + r.height / 2 });
          },
          onMouseLeave: () => {
            setTip(null);
          },
          onFocus: (e: React.FocusEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTip({ text, top: r.top + r.height / 2 });
          },
          onBlur: () => {
            setTip(null);
          },
        }
      : {};

  const itemClass = (current: boolean, soon: boolean) =>
    [
      "group/item relative flex h-10 items-center rounded-lg text-[14px] outline-none transition-colors",
      "focus-visible:ring-2 focus-visible:ring-ring",
      compact ? "w-10 justify-center" : "w-full gap-3 px-3",
      current
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
        : soon
          ? "text-muted-foreground/70"
          : "text-sidebar-foreground hover:bg-sidebar-accent/70",
    ].join(" ");

  const marker = (current: boolean) =>
    current ? (
      <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] -translate-x-[3px] rounded-full bg-primary" />
    ) : null;

  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex h-14 shrink-0 items-center border-b border-sidebar-border ${compact ? "justify-center" : "justify-between px-4"}`}
      >
        {compact ? (
          <Link
            href="/"
            aria-label="AnhourMail overview"
            className="flex size-8 items-center justify-center rounded-lg bg-primary font-heading text-[15px] font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            A
          </Link>
        ) : (
          <BrandMark />
        )}
        {mobile && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <X className="size-5" aria-hidden />
          </button>
        )}
      </div>

      <nav
        aria-label="Console"
        className="flex-1 overflow-y-auto px-3 py-4"
        onClick={(e) => {
          // In the drawer, following a link closes it.
          if (mobile && (e.target as HTMLElement).closest("a")) onClose?.();
        }}
      >
        <ul className={`flex flex-col gap-1 ${compact ? "items-center" : ""}`}>
          <li className="w-full" data-nav="overview">
            <Link
              href="/"
              aria-current={isCurrent(pathname, "/", true) ? "page" : undefined}
              aria-label={compact ? "Overview" : undefined}
              className={itemClass(isCurrent(pathname, "/", true), false)}
              {...tipProps("Overview")}
            >
              {marker(isCurrent(pathname, "/", true))}
              <LayoutDashboard className="size-5 shrink-0" aria-hidden />
              {!compact && <span className="truncate">Overview</span>}
            </Link>
          </li>
        </ul>

        {groups.map((g) => {
          const open = compact || !closed.includes(g.id);
          const GroupIcon = g.kind === "platform" ? ShieldAlert : Building2;
          return (
            <section key={g.id} aria-label={g.title} className="mt-5">
              {compact ? (
                <div aria-hidden className="mx-auto mb-2 h-px w-8 bg-sidebar-border" />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    toggleGroup(g.id);
                  }}
                  aria-expanded={open}
                  className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <GroupIcon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{g.title}</span>
                  <ChevronDown
                    className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
                    aria-hidden
                  />
                </button>
              )}
              {open && (
                <ul className={`flex flex-col gap-1 ${compact ? "items-center" : ""}`}>
                  {g.items.map((n) => {
                    const Icon = ICONS[n.icon];
                    const current = n.href ? isCurrent(pathname, n.href, false) : false;
                    const soon = !n.href;
                    const body = (
                      <>
                        {marker(current)}
                        <Icon className="size-5 shrink-0" aria-hidden />
                        {!compact && <span className="min-w-0 flex-1 truncate">{n.label}</span>}
                        {!compact && soon && <span className="am-micro shrink-0">Soon</span>}
                      </>
                    );
                    return (
                      <li key={`${g.id}-${n.label}`} data-nav={n.permission} className="w-full">
                        {n.href ? (
                          <Link
                            href={n.href}
                            aria-current={current ? "page" : undefined}
                            aria-label={compact ? `${n.label} (${g.title})` : undefined}
                            className={itemClass(current, false)}
                            {...tipProps(`${n.label} · ${g.title}`)}
                          >
                            {body}
                          </Link>
                        ) : (
                          <span
                            role="link"
                            aria-disabled="true"
                            aria-label={compact ? `${n.label} (coming soon)` : undefined}
                            tabIndex={compact ? 0 : -1}
                            className={`${itemClass(false, true)} cursor-default`}
                            {...tipProps(`${n.label} · coming soon`)}
                          >
                            {body}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>

      <SidebarFooter person={person} compact={compact} mobile={mobile} />

      {compact && tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed left-[4.5rem] z-50 -translate-y-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-[13px] text-background shadow-lg"
          style={{ top: tip.top }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

/**
 * Console frame: a sidebar that expands (labels, collapsible sections) or compacts to an icon rail
 * (⌘/Ctrl+B, the header button or Preferences; remembered in a cookie so the first paint is right), and on small
 * screens becomes a drawer behind a menu button. The header holds preferences, theme and the person's menu; the
 * sidebar's foot opens the same menu.
 */
export function ConsoleChrome({
  groups,
  user,
  accounts,
  siteUrl,
  initialCompact,
  initialClosed,
  children,
}: {
  groups: ChromeNavGroup[];
  user: MenuUser;
  accounts: MenuAccount[];
  siteUrl: string;
  initialCompact: boolean;
  initialClosed: string[];
  children: ReactNode;
}) {
  const person: Person = { user, accounts, siteUrl };
  const [compact, setCompact] = useState(initialCompact);
  const [closed, setClosed] = useState(initialClosed);
  const [drawer, setDrawer] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  const setCompactSaved = useCallback((next: boolean) => {
    writeSidebarCookie(SIDEBAR_COOKIE, next ? "compact" : "expanded");
    setCompact(next);
  }, []);
  const toggle = useCallback(() => {
    setCompact((c) => {
      writeSidebarCookie(SIDEBAR_COOKIE, c ? "expanded" : "compact");
      return !c;
    });
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setClosed((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeSidebarCookie(GROUPS_COOKIE, next.join(","));
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [toggle]);

  // Drawer open: lock page scroll; closing returns focus to the menu button.
  useEffect(() => {
    if (!drawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const button = menuButton.current;
    return () => {
      document.body.style.overflow = prev;
      button?.focus();
    };
  }, [drawer]);

  return (
    <div className="flex min-h-dvh w-full">
      <aside
        className={`sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 motion-reduce:transition-none lg:block ${compact ? "w-16" : "w-64"}`}
      >
        <Sidebar
          groups={groups}
          person={person}
          compact={compact}
          mobile={false}
          closed={closed}
          onToggleGroup={toggleGroup}
        />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            tabIndex={-1}
            onClick={() => {
              setDrawer(false);
            }}
            className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]"
          />
          <aside className="absolute inset-y-0 left-0 w-[min(18rem,85vw)] border-r border-sidebar-border bg-sidebar shadow-xl">
            <Sidebar
              groups={groups}
              person={person}
              compact={false}
              mobile
              closed={closed}
              onToggleGroup={toggleGroup}
              onClose={() => {
                setDrawer(false);
              }}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
          <div className="flex h-14 w-full items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              ref={menuButton}
              type="button"
              onClick={() => {
                setDrawer(true);
              }}
              aria-label="Open navigation"
              aria-expanded={drawer}
              className="-ml-2 rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
              aria-keyshortcuts="Control+B Meta+B"
              title={`${compact ? "Expand" : "Collapse"} sidebar (⌘B)`}
              className="-ml-2 hidden rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
            >
              {compact ? (
                <PanelLeftOpen className="size-5" aria-hidden />
              ) : (
                <PanelLeftClose className="size-5" aria-hidden />
              )}
            </button>
            <span className="lg:hidden">
              <BrandMark />
            </span>
            <div className="ml-auto">
              <HeaderActions
                user={user}
                accounts={accounts}
                siteUrl={siteUrl}
                compact={compact}
                setCompact={setCompactSaved}
              />
            </div>
          </div>
        </header>
        <main className="flex min-w-0 flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
