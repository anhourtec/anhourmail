// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { CircleHelp, Menu, Monitor, Moon, Search, Sun, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { type Ref, useEffect, useState, useSyncExternalStore } from "react";

import { Wordmark } from "@anhourmail/ui/wordmark";

import { AccountMenu, Avatar, type MenuAccount, type MenuUser } from "../account-menu";
import { PanelSurface, usePopover } from "../popover";
import { GlobalSearch } from "./global-search";

const barButton =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-appbar-foreground/85 transition-colors hover:bg-appbar-accent hover:text-appbar-foreground focus-visible:ring-2 focus-visible:ring-appbar-foreground/60 focus-visible:outline-none aria-expanded:bg-appbar-accent";

const noop = () => () => undefined;
const CYCLE = { light: "dark", dark: "system", system: "light" } as const;
const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

/** One button that cycles Light → Dark → System; its icon shows the current choice. */
function ThemeCycle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const current = mounted && (theme === "light" || theme === "dark") ? theme : "system";
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  return (
    <button
      type="button"
      onClick={() => {
        setTheme(CYCLE[current]);
      }}
      aria-label={`Theme: ${THEME_LABEL[current]}. Switch to ${THEME_LABEL[CYCLE[current]]}`}
      title={`Theme: ${THEME_LABEL[current]}`}
      className={barButton}
    >
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}

/**
 * One source, shown the same everywhere (CLAUDE.md rule 61): when the person comes back to this tab, ask whether their
 * photo or name changed elsewhere (the webmail, another tab) and re-render the page's server parts if either did.
 * Edits made on this page refresh it themselves.
 */
function useProfileFreshness(photo: string | null, name: string | null) {
  const router = useRouter();
  useEffect(() => {
    const read = async <T,>(url: string): Promise<T | null> => {
      const r = await fetch(url);
      return r.ok ? (((await r.json()) as { data?: T }).data ?? null) : null;
    };
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void Promise.all([read<{ url?: string | null }>("/api/me/avatar"), read<{ name?: string | null }>("/api/me")])
        .then(([a, me]) => {
          const photoChanged = a !== null && (a.url ?? null) !== photo;
          const nameChanged = me !== null && (me.name ?? "") !== (name ?? "");
          if (photoChanged || nameChanged) router.refresh();
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [photo, name, router]);
}

/**
 * The console's app bar (48 px, navy brand surface in both themes): the navigation button (drawer on small screens,
 * collapse to an icon rail on wide ones), the
 * wordmark with "Console", a wide centred search, then theme, help, the account's name and the person's photo (or
 * initials), which open their menu.
 */
export function AppBar({
  user,
  accounts,
  siteUrl,
  orgName,
  staff,
  drawerOpen,
  onOpenDrawer,
  compact,
  onToggleCompact,
  menuButtonRef,
}: {
  user: MenuUser;
  accounts: MenuAccount[];
  siteUrl: string;
  orgName: string | null;
  staff: boolean;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  compact: boolean;
  onToggleCompact: () => void;
  menuButtonRef: Ref<HTMLButtonElement>;
}) {
  const { open: menuOpen, toggle: menuToggle, close: menuClose, trigger: menuTrigger, panel: menuPanel } = usePopover();
  const [searching, setSearching] = useState(false);
  useProfileFreshness(user.photoUrl ?? null, user.name);

  return (
    <header className="sticky top-0 z-40 border-b border-appbar-border bg-appbar text-appbar-foreground">
      <div className="flex h-12 items-center gap-1 px-2 sm:gap-2 sm:px-3">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={onOpenDrawer}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          className={`${barButton} lg:hidden`}
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggleCompact}
          aria-label={compact ? "Expand navigation" : "Collapse navigation"}
          aria-expanded={!compact}
          aria-keyshortcuts="Control+B Meta+B"
          title={`${compact ? "Expand" : "Collapse"} navigation (⌘B)`}
          className={`${barButton} aria-expanded:bg-transparent max-lg:hidden`}
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Link
          href="/"
          aria-label="AnhourMail console home"
          className={`flex shrink-0 items-center gap-2.5 rounded-md px-1.5 py-1 focus-visible:ring-2 focus-visible:ring-appbar-foreground/60 focus-visible:outline-none ${searching ? "max-md:hidden" : ""}`}
        >
          <Wordmark tone="onDark" />
          <span aria-hidden className="hidden h-3.5 w-px bg-appbar-border sm:block" />
          <span className="hidden text-[13px] text-appbar-muted leading-none sm:block">Console</span>
        </Link>

        <div className={`min-w-0 flex-1 justify-center px-2 ${searching ? "flex" : "hidden md:flex"}`}>
          <div className="w-full max-w-[30rem]">
            <GlobalSearch
              staff={staff}
              onDone={() => {
                setSearching(false);
              }}
            />
          </div>
        </div>
        {searching ? (
          <button
            type="button"
            aria-label="Close search"
            onClick={() => {
              setSearching(false);
            }}
            className={`${barButton} md:hidden`}
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 md:ml-0">
            <button
              type="button"
              aria-label="Open search"
              onClick={() => {
                setSearching(true);
                // The input mounts visible on the next frame.
                requestAnimationFrame(() => {
                  document.querySelector<HTMLInputElement>("header input[role=combobox]")?.focus();
                });
              }}
              className={`${barButton} md:hidden`}
            >
              <Search className="size-[18px]" aria-hidden />
            </button>
            <ThemeCycle />
            <a
              href={`${siteUrl}/docs`}
              aria-label="Help and documentation"
              title="Help and documentation"
              className={barButton}
            >
              <CircleHelp className="size-[18px]" aria-hidden />
            </a>
            {orgName && (
              <>
                <span aria-hidden className="mx-1.5 hidden h-5 w-px bg-appbar-border md:block" />
                <span className="hidden max-w-48 truncate text-[13px] text-appbar-foreground md:block" title={orgName}>
                  {orgName}
                </span>
              </>
            )}
            <div className="relative ml-1">
              <button
                ref={menuTrigger}
                type="button"
                onClick={menuToggle}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Your account"
                className="rounded-full focus-visible:ring-2 focus-visible:ring-appbar-foreground/70 focus-visible:outline-none"
              >
                <Avatar name={user.name} email={user.email} photoUrl={user.photoUrl ?? null} size="md" tone="inverse" />
              </button>
              {menuOpen && (
                <div ref={menuPanel} className="absolute top-11 right-0 text-popover-foreground">
                  <PanelSurface>
                    <AccountMenu
                      user={user}
                      accounts={accounts}
                      siteUrl={siteUrl}
                      onNavigate={() => {
                        menuClose(false);
                      }}
                    />
                  </PanelSurface>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
