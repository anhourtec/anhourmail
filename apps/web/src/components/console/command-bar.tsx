// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { menuKeys, PanelSurface, usePopover } from "../popover";

const action =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-[14px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:bg-transparent";

/**
 * The command bar under a page title (console page template): a hairline above, icon + text actions on the left,
 * the list's search box and an overflow menu on the right.
 */
export function CommandBar({
  label,
  children,
  end,
  boxed = false,
}: {
  label: string;
  children?: ReactNode;
  end?: ReactNode;
  /** A raised box (the home page's quick actions) instead of a hairline above. */
  boxed?: boolean;
}) {
  return (
    <div
      aria-label={label}
      role="group"
      className={`flex flex-wrap items-center gap-x-1 gap-y-2 ${boxed ? "rounded-lg border bg-card p-1.5 shadow-sm" : "border-t pt-2"}`}
    >
      {children}
      {end && <div className="ml-auto flex w-full items-center gap-1 sm:w-auto">{end}</div>}
    </div>
  );
}

/** Icon slot: a Lucide element (elements, not components, so server pages can pass them too). */
function Glyph({ icon, spin = false }: { icon: ReactNode; spin?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex text-primary [&>svg]:size-4 ${spin ? "animate-spin motion-reduce:animate-none" : ""}`}
    >
      {icon}
    </span>
  );
}

/** A command bar action that goes somewhere (often a panel: `?new=1`). */
export function CommandLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link href={href} scroll={false} className={action}>
      <Glyph icon={icon} />
      {children}
    </Link>
  );
}

/** A command bar action that does something here. */
export function CommandButton({
  icon,
  onClick,
  disabled = false,
  busy = false,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={action}>
      <Glyph icon={icon} spin={busy} />
      {children}
    </button>
  );
}

/** The list's search box, right of the command bar. Filters what's on the page as the person types. */
export function ListSearch({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder ?? label}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        className="h-8 w-full rounded-md border bg-background pr-2 pl-8 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

export type OverflowItem = { label: string; href: string; icon: ReactNode; external?: boolean };

/** "More actions" (⋯): the command bar's less common actions. */
export function OverflowMenu({ label = "More actions", items }: { label?: string; items: OverflowItem[] }) {
  const { open, toggle, close, trigger, panel } = usePopover();
  if (items.length === 0) return null;
  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent"
      >
        <MoreHorizontal className="size-5" aria-hidden />
      </button>
      {open && (
        <div ref={panel} className="absolute top-10 right-0 z-30">
          <PanelSurface>
            <div role="menu" aria-label={label} onKeyDown={menuKeys} className="flex w-60 flex-col">
              {items.map((i) => {
                const cls =
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent";
                return i.external ? (
                  <a
                    key={i.label}
                    role="menuitem"
                    href={i.href}
                    className={cls}
                    onClick={() => {
                      close(false);
                    }}
                  >
                    <span aria-hidden className="inline-flex text-muted-foreground [&>svg]:size-4">
                      {i.icon}
                    </span>
                    {i.label}
                  </a>
                ) : (
                  <Link
                    key={i.label}
                    role="menuitem"
                    href={i.href}
                    scroll={false}
                    className={cls}
                    onClick={() => {
                      close(false);
                    }}
                  >
                    <span aria-hidden className="inline-flex text-muted-foreground [&>svg]:size-4">
                      {i.icon}
                    </span>
                    {i.label}
                  </Link>
                );
              })}
            </div>
          </PanelSurface>
        </div>
      )}
    </div>
  );
}
