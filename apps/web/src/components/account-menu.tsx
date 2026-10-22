// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { BookOpen, Building2, Check, CircleUser, CreditCard, LogOut, Mail, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { menuKeys } from "./popover";
import { clearSidebarCookies } from "./sidebar-cookies";

export type MenuUser = {
  name: string;
  email: string;
  staffRole: string | null;
  /** The webmail sign-in on its own origin, with the address pre-filled (never a credential; ADR-0018). */
  webmailHref?: string;
};
export type MenuAccount = { id: string; name: string; role: string; href: string };

export function initials(name: string, email: string): string {
  const base = name.trim() !== "" ? name.trim() : (email.split("@")[0] ?? "");
  const words = base.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase() || "?";
}

/** Initials avatar, round (no remote images: privacy rule, branding.md). `inverse` sits on the navy app bar. */
export function Avatar({
  name,
  email,
  size = "md",
  tone = "default",
}: {
  name: string;
  email: string;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: "default" | "inverse";
}) {
  const s =
    size === "xl"
      ? "size-16 text-[22px] sm:size-24 sm:text-[30px]"
      : size === "lg"
        ? "size-10 text-[14px]"
        : size === "sm"
          ? "size-7 text-[11px]"
          : "size-8 text-[12px]";
  const t =
    tone === "inverse"
      ? "bg-appbar-accent text-appbar-foreground ring-1 ring-appbar-foreground/45"
      : "bg-primary/12 text-primary";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-display font-medium ${t} ${s}`}
    >
      {initials(name, email)}
    </span>
  );
}

/**
 * Console sign-out: leave only once the server has ended the session; otherwise `failed` is set (the session would
 * still be valid), so the caller can say so.
 */
export function useSignOut() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const signOut = () => {
    setFailed(false);
    void fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        clearSidebarCookies();
        router.replace("/sign-in");
        router.refresh();
      })
      .catch(() => {
        setFailed(true);
      });
  };
  return { signOut, failed };
}

const itemClass =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent";

/**
 * The person's menu: who they are, their accounts (current one ticked), then account-wide pages and sign-out.
 * Pages not built yet are listed as "Soon" and can't be chosen.
 */
export function AccountMenu({
  user,
  accounts,
  siteUrl,
  onNavigate,
}: {
  user: MenuUser;
  accounts: MenuAccount[];
  siteUrl: string;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const currentId = /^\/accounts\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const { signOut, failed: signOutError } = useSignOut();

  const soon = (label: string, Icon: typeof CircleUser) => (
    <span role="menuitem" aria-disabled="true" className={`${itemClass} cursor-default text-muted-foreground`}>
      <Icon className="size-4" aria-hidden />
      <span className="flex-1">{label}</span>
      <span className="am-micro">Soon</span>
    </span>
  );

  return (
    <div role="menu" aria-label="Your account" onKeyDown={menuKeys} className="flex w-72 flex-col">
      <div className="flex items-center gap-3 px-2.5 py-2">
        <Avatar name={user.name} email={user.email} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-[14px]">{user.name || user.email}</span>
          <span className="am-micro truncate">{user.email}</span>
          {user.staffRole && <span className="am-micro truncate">Anhourtec staff · {user.staffRole}</span>}
        </div>
      </div>

      {accounts.length > 0 && (
        <>
          <div role="separator" className="my-1 h-px bg-border" />
          {accounts.map((a) => {
            const current = a.id === currentId;
            return (
              <Link
                key={a.id}
                role="menuitem"
                href={a.href}
                aria-current={current ? "true" : undefined}
                onClick={onNavigate}
                className={`${itemClass} ${current ? "bg-accent/60" : ""}`}
              >
                <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="am-micro truncate">{a.role}</span>
                </span>
                {current && <Check className="size-4 shrink-0" aria-label="Current account" />}
              </Link>
            );
          })}
        </>
      )}

      <div role="separator" className="my-1 h-px bg-border" />
      <Link role="menuitem" href="/security" onClick={onNavigate} className={itemClass}>
        <ShieldCheck className="size-4" aria-hidden />
        Security
      </Link>
      {soon("Profile", CircleUser)}
      {soon("Billing", CreditCard)}
      {user.webmailHref && (
        <a role="menuitem" href={user.webmailHref} className={itemClass} onClick={onNavigate}>
          <Mail className="size-4" aria-hidden />
          Open webmail
        </a>
      )}
      <a role="menuitem" href={`${siteUrl}/docs`} className={itemClass} onClick={onNavigate}>
        <BookOpen className="size-4" aria-hidden />
        Documentation
      </a>

      <div role="separator" className="my-1 h-px bg-border" />
      <button type="button" role="menuitem" onClick={signOut} className={itemClass}>
        <LogOut className="size-4" aria-hidden />
        Sign out
      </button>
      {signOutError && (
        <p role="alert" className="am-micro px-2.5 pb-1.5 text-destructive">
          Couldn't sign out. Check your connection and try again.
        </p>
      )}
    </div>
  );
}
