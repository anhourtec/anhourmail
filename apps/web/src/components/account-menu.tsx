// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { BookOpen, Building2, Check, CircleUser, CreditCard, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { menuKeys } from "./popover";
import { clearSidebarCookies } from "./sidebar-cookies";

export type MenuUser = { name: string; email: string; staffRole: string | null };
export type MenuAccount = { id: string; name: string; role: string; href: string };

export function initials(name: string, email: string): string {
  const base = name.trim() !== "" ? name.trim() : (email.split("@")[0] ?? "");
  const words = base.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase() || "?";
}

/** Initials avatar (no remote images: privacy rule, branding.md). */
export function Avatar({ name, email, size = "md" }: { name: string; email: string; size?: "sm" | "md" | "lg" }) {
  const s = size === "lg" ? "size-10 text-[14px]" : size === "sm" ? "size-7 text-[11px]" : "size-8 text-[12px]";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-lg bg-primary/12 font-medium text-primary ${s}`}
    >
      {initials(name, email)}
    </span>
  );
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
  const router = useRouter();
  const currentId = /^\/accounts\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const [signOutError, setSignOutError] = useState(false);

  // Leave only once the server has ended the session; otherwise say so (the session would still be valid).
  const signOut = () => {
    setSignOutError(false);
    void fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        clearSidebarCookies();
        router.replace("/sign-in");
        router.refresh();
      })
      .catch(() => {
        setSignOutError(true);
      });
  };

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
      {soon("Profile and security", CircleUser)}
      {soon("Billing", CreditCard)}
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
