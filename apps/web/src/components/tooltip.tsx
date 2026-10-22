// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Hover delay before a tooltip shows; keyboard focus shows it at once. */
export const TOOLTIP_DELAY_MS = 150;
/** Moving straight from one tooltip to the next skips the delay. */
const WARM_MS = 400;
const GAP = 6;
const EDGE = 8;

let lastHidden = 0;

/**
 * A small label for an icon button (and its keyboard shortcut, in a mono keycap). Shows after a short hover delay
 * and at once on keyboard focus; hides on leave, blur, click or Escape. Positioned below the trigger (above when
 * there is no room; or beside it with `side="right"`, flipping left at the edge) and kept inside the viewport. The
 * child is wrapped in a `display: contents` span, so layout is unchanged. The trigger keeps its own `aria-label`; the tooltip is linked
 * with `aria-describedby` while it shows. No `title` attribute, so the browser's own slow tooltip never doubles it.
 */
export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  disabled = false,
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  side?: "bottom" | "top" | "right";
  /** Never shows (e.g. while the trigger's own menu is open). */
  disabled?: boolean;
  children: ReactElement;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen((o) => {
      if (o) lastHidden = Date.now();
      return false;
    });
    setPos(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onScroll = () => {
      hide();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, hide]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || !trigger.current || !tip.current) return;
    const r = trigger.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (side === "right") {
      const right = r.right + GAP;
      const left = right + t.width > vw - EDGE ? Math.max(EDGE, r.left - GAP - t.width) : right;
      const top = Math.min(Math.max(EDGE, r.top + r.height / 2 - t.height / 2), Math.max(EDGE, vh - EDGE - t.height));
      setPos({ top, left });
      return;
    }
    const below = r.bottom + GAP;
    const above = r.top - GAP - t.height;
    let top = side === "bottom" ? below : above;
    if (side === "bottom" && below + t.height > vh - EDGE && above >= EDGE) top = above;
    if (side === "top" && above < EDGE) top = below;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - t.width / 2), Math.max(EDGE, vw - EDGE - t.width));
    setPos({ top, left });
  }, [open, side, label, shortcut]);

  const visible = open && !disabled;
  const show = (now: boolean) => {
    window.clearTimeout(timer.current);
    if (disabled) return;
    if (now || Date.now() - lastHidden < WARM_MS) setOpen(true);
    else
      timer.current = window.setTimeout(() => {
        setOpen(true);
      }, TOOLTIP_DELAY_MS);
  };

  // Links the tooltip to its trigger while it shows (the trigger keeps its own aria-label).
  useEffect(() => {
    const el = trigger.current;
    if (!visible || !el) return;
    const before = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", [before, id].filter(Boolean).join(" "));
    return () => {
      if (before === null) el.removeAttribute("aria-describedby");
      else el.setAttribute("aria-describedby", before);
    };
  }, [visible, id]);

  const triggerOf = (target: EventTarget, wrapper: HTMLElement): HTMLElement =>
    target instanceof HTMLElement && target !== wrapper
      ? (target.closest<HTMLElement>("button, a, [tabindex]") ?? target)
      : wrapper;

  return (
    <>
      <span
        className="contents"
        onPointerEnter={(e: PointerEvent<HTMLSpanElement>) => {
          trigger.current = (e.currentTarget.firstElementChild as HTMLElement | null) ?? e.currentTarget;
          if (e.pointerType !== "touch") show(false);
        }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e: FocusEvent<HTMLSpanElement>) => {
          trigger.current = triggerOf(e.target, e.currentTarget);
          // Keyboard focus only (a click also focuses the button).
          if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) show(true);
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            className="pointer-events-none fixed z-[70] flex max-w-64 items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-[12px] text-background leading-tight shadow-md"
          >
            <span>{label}</span>
            {shortcut && (
              <kbd className="rounded border border-background/30 px-1 font-mono text-[11px] leading-[1.35]">
                {shortcut}
              </kbd>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
