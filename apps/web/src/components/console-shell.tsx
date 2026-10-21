// SPDX-License-Identifier: AGPL-3.0-only
import { BrandMark } from "./brand-mark";
import { NavLink } from "./nav-link";
import { SignOutButton } from "./sign-out-button";
import { ThemeToggle } from "./theme-toggle";

export type ShellNavGroup = {
  title: string;
  items: { label: string; permission: string; phase: number; href?: string }[];
};

/**
 * Full-width console frame: edge-to-edge header, a navigation rail derived from the permission matrix
 * (console-nav.ts) and a content area that uses the whole remaining width. The rail collapses into a
 * horizontal scroller under `lg`.
 */
export function ConsoleShell({
  email,
  groups,
  children,
}: {
  email: string;
  groups: ShellNavGroup[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="flex h-14 w-full items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <BrandMark />
          <div className="flex items-center gap-2">
            <span className="am-small hidden md:inline">{email}</span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex w-full flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Console"
          className="border-b bg-sidebar lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <div className="flex gap-6 overflow-x-auto px-4 py-3 sm:px-6 lg:flex-col lg:gap-6 lg:px-4 lg:py-6">
            <ul className="flex shrink-0 gap-1 lg:flex-col">
              <li className="shrink-0">
                <NavLink href="/" exact>
                  Overview
                </NavLink>
              </li>
            </ul>
            {groups.map((g) => (
              <div key={g.title} className="flex shrink-0 flex-col gap-1.5">
                <span className="am-mono px-2">{g.title}</span>
                <ul className="flex gap-1 lg:flex-col">
                  {g.items.map((n) => (
                    <li key={`${g.title}-${n.label}`} data-nav={n.permission} className="shrink-0">
                      {n.href ? (
                        <NavLink href={n.href}>{n.label}</NavLink>
                      ) : (
                        <span className="flex items-center justify-between gap-3 px-2 py-1.5 text-[14px] text-muted-foreground">
                          <span>{n.label}</span>
                          {n.phase > 0 && <span className="am-micro">phase {n.phase}</span>}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main className="flex min-w-0 flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
