// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { NavTreeSection } from "@/server/console-nav";

import { type MenuAccount, type MenuUser, useSignOut } from "./account-menu";
import { AppBar } from "./console/app-bar";
import { Flyout } from "./console/flyout";
import { LeftNav, type NavCounts, type PrimaryAction } from "./console/left-nav";
import { SIDEBAR_COOKIE, writeSidebarCookie } from "./sidebar-cookies";

const SHORTCUTS: [string, string][] = [
  ["/", "Search the console"],
  ["⌘ B or Ctrl B", "Collapse or expand the navigation"],
  ["Esc", "Close a panel, menu or search"],
  ["?", "Show these shortcuts"],
];

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]") !== null;
}

/**
 * Console frame: a 48 px app bar across the top, the left navigation below it (the shared sidebar design: wide, or
 * an icon rail toggled by the app bar's menu button or ⌘/Ctrl+B and remembered in a cookie so the first paint is
 * right), and the page. Under `lg` the navigation is a drawer behind the same button.
 */
export function ConsoleChrome({
  tree,
  counts,
  primary,
  user,
  accounts,
  currentAccountId,
  siteUrl,
  orgName,
  staff,
  initialCompact,
  children,
}: {
  tree: NavTreeSection[];
  counts: NavCounts;
  primary: PrimaryAction | null;
  user: MenuUser;
  accounts: MenuAccount[];
  currentAccountId: string | null;
  siteUrl: string;
  orgName: string | null;
  staff: boolean;
  initialCompact: boolean;
  children: ReactNode;
}) {
  const [compact, setCompact] = useState(initialCompact);
  const [drawer, setDrawer] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const { signOut, failed: signOutFailed } = useSignOut();
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawerPanel = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    setCompact((c) => {
      writeSidebarCookie(SIDEBAR_COOKIE, c ? "expanded" : "compact");
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      } else if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [toggle]);

  // Drawer open: lock page scroll, keep focus inside, Escape closes; closing returns focus to the menu button.
  useEffect(() => {
    if (!drawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const button = menuButton.current;
    drawerPanel.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
      if (e.key !== "Tab" || !drawerPanel.current) return;
      const items = [...drawerPanel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      button?.focus();
    };
  }, [drawer]);

  const nav = (mobile: boolean) => (
    <LeftNav
      tree={tree}
      counts={counts}
      primary={primary}
      user={user}
      accounts={accounts}
      currentAccountId={currentAccountId}
      siteUrl={siteUrl}
      compact={mobile ? false : compact}
      mobile={mobile}
      onClose={() => {
        setDrawer(false);
      }}
      onShortcuts={() => {
        setDrawer(false);
        setShortcuts(true);
      }}
      onSignOut={signOut}
    />
  );

  return (
    <div className="flex min-h-dvh w-full flex-col">
      <AppBar
        user={user}
        accounts={accounts}
        siteUrl={siteUrl}
        orgName={orgName}
        staff={staff}
        drawerOpen={drawer}
        onOpenDrawer={() => {
          setDrawer(true);
        }}
        compact={compact}
        onToggleCompact={toggle}
        menuButtonRef={menuButton}
      />

      {signOutFailed && (
        <p role="alert" className="am-small border-b bg-destructive/10 px-4 py-2 text-destructive">
          Couldn&apos;t sign out. Check your connection and try again.
        </p>
      )}

      <div className="flex min-w-0 flex-1">
        <aside
          aria-label="Navigation"
          data-collapsed={compact ? "true" : "false"}
          className={`sticky top-12 hidden h-[calc(100dvh-3rem)] shrink-0 border-r border-sidebar-border transition-[width] duration-200 motion-reduce:transition-none lg:block ${compact ? "w-14" : "w-60"}`}
        >
          {nav(false)}
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button
              type="button"
              aria-label="Close navigation"
              tabIndex={-1}
              onClick={() => {
                setDrawer(false);
              }}
              className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]"
            />
            <div
              ref={drawerPanel}
              className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-sidebar-border shadow-xl"
            >
              {nav(true)}
            </div>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col gap-5 px-4 pt-5 pb-10 sm:px-6 lg:px-10 lg:pt-6">{children}</main>
      </div>

      {shortcuts && (
        <Flyout
          label="Keyboard shortcuts"
          size="md"
          onClose={() => {
            setShortcuts(false);
          }}
        >
          <div className="flex flex-col gap-5">
            <h2 className="am-h2">Keyboard shortcuts</h2>
            <dl className="flex flex-col border-t">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="flex min-h-[46px] items-center justify-between gap-4 border-b">
                  <dt className="text-[14px]">{what}</dt>
                  <dd>
                    <kbd className="am-num rounded border px-1.5 py-0.5 text-[12px]">{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Flyout>
      )}
    </div>
  );
}
