// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Keyboard, LifeBuoy, LogOut, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Tooltip } from "@/components/tooltip";

/**
 * Sidebar building blocks shared by the webmail and the console (branding.md "Sidebar"): an identity block (tiles,
 * name, address, ⋮ menu), one prominent action, icon + label rows with counts on the right, muted section labels,
 * and a foot with help, keyboard shortcuts, theme and sign out. Every piece takes `collapsed` for the icon rail.
 */

/** The sidebar surface. */
export function SidebarFrame({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">{children}</div>;
}

/** A square initial tile (mailbox, account), with a check badge on the current one. */
export function SidebarTile({
  text,
  active = false,
  size = "md",
}: {
  text: string;
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center rounded-md bg-primary font-medium text-primary-foreground ${
        size === "sm" ? "size-7 text-[12px]" : "size-8 text-[13px]"
      }`}
    >
      {text.charAt(0).toUpperCase()}
      {active && (
        <span className="-right-1 -bottom-1 absolute flex size-3.5 items-center justify-center rounded-full bg-[rgb(var(--am-status-success-bg))] text-primary-foreground ring-2 ring-sidebar">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

/**
 * Top of the sidebar: a row of tiles (a switcher) with a ⋮ menu, then the name and address under a hairline. In the
 * rail only `railTrigger` (usually the current tile opening the menu) shows.
 */
export function SidebarIdentity({
  collapsed,
  tiles,
  menu,
  railMenu,
  name,
  detail,
  children,
}: {
  collapsed: boolean;
  tiles: ReactNode;
  menu: ReactNode;
  railMenu: ReactNode;
  name: string;
  detail: string;
  /** The primary action, under the identity. */
  children?: ReactNode;
}) {
  return (
    <div className={`flex shrink-0 flex-col gap-3 pt-3 pb-2 ${collapsed ? "items-center px-2" : "px-3"}`}>
      <div className="flex items-center gap-1.5">
        {collapsed ? (
          railMenu
        ) : (
          <>
            <div className="flex flex-1 flex-wrap items-center gap-1.5">{tiles}</div>
            {menu}
          </>
        )}
      </div>
      {!collapsed && (
        <div className="flex min-w-0 flex-col gap-0.5 border-sidebar-border border-t pt-3">
          <span className="truncate font-medium text-[14px]">{name}</span>
          <Tooltip label={detail}>
            <span className="truncate font-mono text-[12px] text-muted-foreground">{detail}</span>
          </Tooltip>
        </div>
      )}
      {children}
    </div>
  );
}

const primaryClass = (collapsed: boolean, disabled = false) =>
  `inline-flex h-9 items-center justify-center gap-2 rounded-lg border bg-background font-medium text-[13.5px] shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
    disabled ? "cursor-not-allowed opacity-60" : "hover:bg-accent"
  } ${collapsed ? "w-9" : "w-full"}`;

/** The one prominent action (New email, Add a mailbox, …): a link or a button. */
export function SidebarPrimaryAction({
  label,
  icon: Icon,
  collapsed,
  href,
  onClick,
  shortcut,
  disabledReason,
}: {
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
  href?: string;
  onClick?: () => void;
  shortcut?: string;
  /**
   * The action exists but can't be used now (the account is full): shown disabled, with this reason beside it (in
   * the rail, as its tooltip and description).
   */
  disabledReason?: string | undefined;
}) {
  const reasonId = useId();
  const body = (
    <>
      <Icon className="size-4" aria-hidden />
      <span className={collapsed ? "sr-only" : undefined}>{label}</span>
    </>
  );
  if (disabledReason) {
    return (
      <div className={`flex flex-col gap-1 ${collapsed ? "items-center" : ""}`}>
        <Tooltip
          label={collapsed ? `${label}: ${disabledReason}` : disabledReason}
          side={collapsed ? "right" : "bottom"}
        >
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={reasonId}
            className={primaryClass(collapsed, true)}
          >
            {body}
          </button>
        </Tooltip>
        <span id={reasonId} className={collapsed ? "sr-only" : "am-micro"}>
          {disabledReason}
        </span>
      </div>
    );
  }
  return (
    <Tooltip label={label} {...(shortcut ? { shortcut } : {})} side={collapsed ? "right" : "bottom"}>
      {href ? (
        <Link href={href} scroll={false} className={primaryClass(collapsed)}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={primaryClass(collapsed)}>
          {body}
        </button>
      )}
    </Tooltip>
  );
}

/**
 * One navigation row: icon, label, count on the right (a dot in the rail). The current row gets the accent tint and a
 * primary icon. A link when `href` is given, else a button; `soon` rows are listed but can't be chosen.
 */
export function SidebarNavItem({
  icon: Icon,
  label,
  count = 0,
  current = false,
  collapsed,
  href,
  onClick,
  emphasis = false,
  soon = false,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  current?: boolean;
  collapsed: boolean;
  href?: string;
  onClick?: () => void;
  emphasis?: boolean;
  soon?: boolean;
}) {
  const className = `group flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-[13.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
    collapsed ? "justify-center px-0" : "px-2.5"
  } ${
    soon
      ? "cursor-default text-muted-foreground"
      : current
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
  }`;
  // The name comes from text (visually hidden in the rail), not aria-label, so it reads like the visible row.
  const body = (
    <>
      <span className="relative">
        <Icon className={`size-4 shrink-0 ${current ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
        {collapsed && count > 0 && (
          <span aria-hidden className="-right-1 -top-1 absolute size-1.5 rounded-full bg-primary" />
        )}
      </span>
      <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>{label}</span>
      {soon && <span className={collapsed ? "sr-only" : "am-micro"}>{collapsed ? " (coming soon)" : "Soon"}</span>}
      {!soon && count > 0 && (
        <span
          className={
            collapsed
              ? "sr-only"
              : `font-mono text-[11.5px] tabular-nums ${emphasis || current ? "text-primary" : "text-muted-foreground"}`
          }
        >
          <span className="sr-only">, </span>
          {count > 999 ? "999+" : count}
        </span>
      )}
    </>
  );
  return (
    <Tooltip label={soon ? `${label} · coming soon` : label} side="right" disabled={!collapsed}>
      {soon ? (
        <span role="link" aria-disabled="true" tabIndex={collapsed ? 0 : -1} className={className}>
          {body}
        </span>
      ) : href ? (
        <Link href={href} aria-current={current ? "page" : undefined} className={className}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} aria-current={current ? "page" : undefined} className={className}>
          {body}
        </button>
      )}
    </Tooltip>
  );
}

/** A muted section label ("Folders", "Mail"); a hairline in the rail. */
export function SidebarSection({ label, collapsed }: { label: string; collapsed: boolean }) {
  return collapsed ? (
    <div aria-hidden className="mx-2 my-2 h-px bg-sidebar-border" />
  ) : (
    <p className="am-micro px-2.5 pt-4 pb-1">{label}</p>
  );
}

const footRow = (collapsed: boolean) =>
  `flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-[13.5px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground ${collapsed ? "justify-center" : "px-2.5"}`;

/** The foot: help & feedback, keyboard shortcuts, then theme and sign out (expanded only). */
export function SidebarFooter({
  collapsed,
  helpHref,
  onShortcuts,
  onSignOut,
}: {
  collapsed: boolean;
  helpHref: string;
  onShortcuts: () => void;
  onSignOut: () => void;
}) {
  return (
    <div
      className={`flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t p-2 ${collapsed ? "items-center" : ""}`}
    >
      <Tooltip label="Help & feedback" side="right" disabled={!collapsed}>
        <a
          href={helpHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Help & feedback"
          className={footRow(collapsed)}
        >
          <LifeBuoy className="size-4 text-muted-foreground" aria-hidden />
          {!collapsed && "Help & feedback"}
        </a>
      </Tooltip>
      <Tooltip label="Keyboard shortcuts" shortcut="?" side="right" disabled={!collapsed}>
        <button type="button" onClick={onShortcuts} aria-label="Keyboard shortcuts" className={footRow(collapsed)}>
          <Keyboard className="size-4 text-muted-foreground" aria-hidden />
          {!collapsed && "Keyboard shortcuts"}
        </button>
      </Tooltip>
      {!collapsed && (
        <div className="flex items-center justify-between gap-2 px-1 pt-2">
          <ThemeToggle />
          <Tooltip label="Sign out">
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <LogOut className="size-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
