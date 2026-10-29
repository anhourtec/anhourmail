// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal disclosure for menus and popovers (no dependency): opens from a trigger button, closes on Escape,
 * outside click or `close()`, and returns focus to the trigger. Placement is up to the caller (absolute/fixed).
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Move focus into the panel: the first focusable element.
    panel.current?.querySelector<HTMLElement>("[role=menuitem], button, a, [tabindex='0']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return {
    open,
    close,
    trigger,
    panel,
    toggle: () => {
      setOpen((o) => !o);
    },
  };
}

/** Arrow keys, Home and End move between a menu's items, checkable ones too (WAI-ARIA menu pattern). */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      ":is([role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]):not([aria-disabled=true])",
    ),
  ];
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
}

/** Floating surface for menus and popovers (tokens only). */
export function PanelSurface({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`z-50 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 ${className}`}
    >
      {children}
    </div>
  );
}
