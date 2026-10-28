// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Building blocks for the hand-drawn product pictures (webmail and console). They copy the shapes of the real apps
 * (apps/web) with site tokens only: no screenshots, no remote images, sample data only. Everything here renders
 * inside an `aria-hidden` mock, so none of it is announced.
 */
import type { CSSProperties, ReactNode } from "react";

import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  KeyboardIcon,
  LifeBuoyIcon,
  LockIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Wordmark } from "@anhourmail/ui/wordmark";

export const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

/** Sample addresses: a placeholder custom domain, never a real person's. */
export const DEMO_DOMAIN = "yourname.com";

/** Illustrative DKIM keys (shortened, not real): the console shows each domain's own. */
export const DEMO_DKIM_KEYS = [
  { selector: "v1-rsa-20261028", value: "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEF…" },
  { selector: "v1-ed25519-20261028", value: "v=DKIM1; k=ed25519; h=sha256; p=T5HnScT90Bl3e6wO…" },
];
export const DEMO_ME = `alex@${DEMO_DOMAIN}`;
export const DEMO_MASKED = `b4e19c07d2@${DEMO_DOMAIN}`;

/** The webmail's avatar tones (message-list.tsx TONES), so sample senders get the same tinted squares. */
const TONES = [
  "bg-chart-1/14 text-chart-1",
  "bg-chart-2/16 text-chart-2",
  "bg-chart-3/16 text-chart-3",
  "bg-chart-4/14 text-chart-4",
  "bg-chart-5/16 text-chart-5",
] as const;

/** Square initials avatar (the apps never load remote pictures). */
export function MockAvatar({
  label,
  tone = 0,
  size = "md",
  round = false,
}: {
  label: string;
  tone?: number;
  size?: "sm" | "md" | "lg" | "xl";
  round?: boolean;
}) {
  const s =
    size === "xl"
      ? "size-14 text-[19px]"
      : size === "lg"
        ? "size-10 text-[13px]"
        : size === "sm"
          ? "size-7 text-[10.5px]"
          : "size-8 text-[11.5px]";
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-medium ${round ? "rounded-full" : "rounded-md"} ${TONES[tone % TONES.length] ?? TONES[0]} ${s}`}
    >
      {label}
    </span>
  );
}

/** The account/mailbox tile at the top of both sidebars: a brand square with a green "signed in" check. */
export function SidebarTile({ letter }: { letter: string }) {
  return (
    <span className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary font-medium text-[13px] text-primary-foreground">
      {letter}
      <span className="absolute -right-1 -bottom-1 inline-flex size-3.5 items-center justify-center rounded-full bg-[rgb(var(--am-status-success-bg))] ring-2 ring-sidebar">
        <span className="h-1 w-1.5 -translate-y-px rotate-[-45deg] border-b-[1.5px] border-l-[1.5px] border-white" />
      </span>
    </span>
  );
}

/** A sidebar row: icon, label, optional count. `active` gets the accent fill and brand-coloured icon and count. */
export function NavRow({
  icon: Icon,
  label,
  count,
  active = false,
  indent = false,
}: {
  icon: LucideIcon;
  label: string;
  count?: number | string;
  active?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex h-7 items-center gap-2.5 rounded-md px-2 text-[12.5px] ${active ? "bg-accent font-medium text-foreground" : "text-foreground/85"} ${indent ? "pl-5" : ""}`}
    >
      <Icon className={`size-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className={`text-[11px] tabular-nums ${active ? "text-primary" : "text-muted-foreground"}`}>{count}</span>
      ) : null}
    </div>
  );
}

export function NavLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-3 pb-1 text-[11px] text-muted-foreground">{children}</div>;
}

/** Help, shortcuts and the three-way theme switch at the foot of both sidebars. */
export function SidebarFooter() {
  return (
    <div className="mt-auto flex flex-col gap-0.5 border-t p-2">
      <NavRow icon={LifeBuoyIcon} label="Help & feedback" />
      <NavRow icon={KeyboardIcon} label="Keyboard shortcuts" />
      <div className="mt-1 flex items-center justify-between px-1">
        <span className="flex items-center gap-0.5 rounded-md border p-0.5">
          <span className="inline-flex size-6 items-center justify-center rounded text-muted-foreground">
            <SunIcon className="size-3.5" />
          </span>
          <span className="inline-flex size-6 items-center justify-center rounded text-muted-foreground">
            <MoonIcon className="size-3.5" />
          </span>
          <span className="inline-flex size-6 items-center justify-center rounded bg-accent text-foreground">
            <MonitorIcon className="size-3.5" />
          </span>
        </span>
        <LogOutIcon className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}

const STATUS: Record<"success" | "warning" | "neutral", { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheckIcon, className: "text-[rgb(var(--am-status-success))]" },
  warning: { icon: TriangleAlertIcon, className: "text-[rgb(var(--am-status-warning))]" },
  neutral: { icon: CircleMinusIcon, className: "text-muted-foreground" },
};

/** Status as the apps show it: a small coloured icon and plain text ("Active", "Waiting for DNS"). */
export function MockStatus({
  tone,
  children,
  className = "",
}: {
  tone: "success" | "warning" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  const t = STATUS[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12.5px] text-foreground ${className}`}>
      <t.icon className={`size-3.5 shrink-0 ${t.className}`} />
      <span>{children}</span>
    </span>
  );
}

/** A small on/off switch in the brand colour (off = border grey). */
export function MockSwitch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-[18px] w-8 shrink-0 rounded-full ${on ? "bg-primary" : "bg-border dark:bg-white/20"}`}
    >
      <span
        className={`absolute top-[3px] size-3 rounded-full bg-background shadow-sm ${on ? "left-[17px]" : "left-[3px]"}`}
      />
    </span>
  );
}

/** A checkbox square as drawn in the console lists. */
export function MockCheckbox() {
  return <span className="inline-block size-3.5 shrink-0 rounded-[4px] border-[1.5px] border-muted-foreground/60" />;
}

/**
 * Browser chrome around a full-app picture: three dots and the app's hostname. The drawing is hidden from assistive
 * tech; `label` is the short text alternative read in its place.
 */
export function BrowserFrame({ host, label, children }: { host: string; label: string; children: ReactNode }) {
  return (
    <>
      <p className="sr-only">{label}</p>
      <div aria-hidden="true" className="am-site-frame select-none">
        <div className="am-site-frame-bar">
          <span className="flex gap-1.5">
            <span className="am-site-frame-dot" />
            <span className="am-site-frame-dot" />
            <span className="am-site-frame-dot" />
          </span>
          <span className="am-site-frame-url">
            <LockIcon className="size-3" />
            {host}
          </span>
          <span className="w-[42px]" />
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * The console's app bar: the navy brand surface in both themes, so the logo uses its on-dark variant. Menu button,
 * logo with "Console", a wide centred search (an icon on narrow frames), help and the account's initials.
 */
export function ConsoleAppBar({ account, initials }: { account: string; initials: string }) {
  return (
    <div className="flex h-11 items-center gap-3 border-b border-appbar-border bg-appbar px-3 text-appbar-foreground">
      <MenuIcon className="size-4 shrink-0 opacity-85" />
      <span className="flex shrink-0 items-center gap-2">
        <Wordmark tone="onDark" logoClassName="h-3 w-auto" />
        <span className="h-3 w-px bg-appbar-border" />
        <span className="text-[11.5px] text-appbar-muted">Console</span>
      </span>
      <span className="flex flex-1 justify-center">
        <span className="hidden h-7 w-full max-w-[340px] items-center gap-2 rounded-md bg-background px-2.5 text-[11.5px] text-muted-foreground @2xl:flex dark:bg-white/10 dark:text-appbar-muted">
          <SearchIcon className="size-3.5" />
          <span className="flex-1 truncate">Search mailboxes, domains and people</span>
          <span className="rounded border px-1 font-mono text-[10px] dark:border-appbar-border">/</span>
        </span>
      </span>
      <SearchIcon className="size-4 shrink-0 opacity-85 @2xl:hidden" />
      <CircleHelpIcon className="hidden size-4 shrink-0 opacity-85 @md:block" />
      <span className="hidden text-[11.5px] @xl:inline">{account}</span>
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-appbar-border bg-white/10 font-medium text-[10.5px]">
        {initials}
      </span>
    </div>
  );
}
