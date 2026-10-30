// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { menuKeys, PanelSurface, usePopover } from "@/components/popover";
import { Tooltip } from "@/components/tooltip";

export type MenuEntry =
  | {
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** A checkable item (filter menus, the mailbox list). */
      checked?: boolean;
      hint?: string;
      /** The label is an address: shown in mono, truncated, with the whole of it as the tooltip. */
      mono?: boolean;
    }
  | { separator: true }
  | { heading: string };

export const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-accent aria-expanded:text-foreground";

/** A dropdown menu on an icon button (keyboard: arrows, Home/End, Escape). */
export function Menu({
  label,
  icon: Icon,
  items,
  align = "end",
  side = "bottom",
  trigger,
  className = "",
  fill = false,
}: {
  label: string;
  icon: LucideIcon;
  items: MenuEntry[];
  align?: "start" | "end";
  side?: "bottom" | "top";
  /** Replaces the default icon button content. */
  trigger?: ReactNode;
  className?: string;
  /**
   * The panel starts at the nearest positioned ancestor's left edge and is at least as wide as it (the webmail
   * sidebar's account menu under the sidebar header), growing with its labels up to 20rem; longer ones truncate.
   */
  fill?: boolean;
}) {
  const { open, toggle, close, trigger: triggerRef, panel } = usePopover();
  return (
    <div className={`${fill ? "" : "relative"} ${className}`}>
      <Tooltip label={label} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          className={trigger ? "rounded-lg focus-visible:ring-2 focus-visible:ring-ring" : iconButtonClass}
        >
          {trigger ?? <Icon className="size-4" aria-hidden />}
        </button>
      </Tooltip>
      {open && (
        <div
          ref={panel}
          className={`absolute z-50 ${fill ? "left-0 w-max min-w-full max-w-[min(20rem,calc(100vw-1.5rem))]" : align === "end" ? "right-0" : "left-0"} ${side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}
        >
          <PanelSurface
            className={`max-h-[min(40rem,calc(100dvh-6rem))] overflow-y-auto overscroll-contain ${fill ? "w-full" : "min-w-52 max-w-80"}`}
          >
            <div role="menu" aria-label={label} onKeyDown={menuKeys} className="flex flex-col">
              {items.map((item, i) => {
                if ("separator" in item) {
                  return <div key={`sep-${String(i)}`} role="separator" className="my-1 h-px bg-border" />;
                }
                if ("heading" in item) {
                  return (
                    <p key={`h-${item.heading}`} className="am-micro px-2.5 pt-1.5 pb-1">
                      {item.heading}
                    </p>
                  );
                }
                const ItemIcon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    {...(item.mono ? { title: item.label } : {})}
                    role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    {...(item.checked === undefined ? {} : { "aria-checked": item.checked })}
                    aria-disabled={item.disabled === true ? true : undefined}
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-40 ${item.danger ? "text-destructive" : ""}`}
                  >
                    {item.checked !== undefined ? (
                      <span className="flex size-4 items-center justify-center">
                        {item.checked && <Check className="size-3.5" aria-hidden />}
                      </span>
                    ) : (
                      ItemIcon && <ItemIcon className="size-4 shrink-0" aria-hidden />
                    )}
                    <span className={`min-w-0 flex-1 truncate ${item.mono ? "font-mono text-[12.5px]" : ""}`}>
                      {item.label}
                    </span>
                    {item.hint && <kbd className="font-mono text-[11px] text-muted-foreground">{item.hint}</kbd>}
                  </button>
                );
              })}
            </div>
          </PanelSurface>
        </div>
      )}
    </div>
  );
}
