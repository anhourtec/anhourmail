// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowDown, ArrowUp, Check, Minus, MoreVertical, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { menuKeys, PanelSurface } from "../popover";
import { listClass } from "./list-classes";

export { listClass };

/**
 * Console list primitives (page template, "Lists"): sortable headers, a checkbox column with a bulk bar, a ⋮ menu
 * per row, filter chips. Rows are ~46 px with hairline separators; the primary column is medium weight.
 */

export type SortDir = "asc" | "desc";
export type Sort<K extends string> = { key: K; dir: SortDir };

/** Client-side sorting over a complete list; text compares naturally, numbers and dates numerically. */
export function useSort<T, K extends string>(
  rows: readonly T[],
  keys: Record<K, (row: T) => string | number>,
  initial: Sort<NoInfer<K>>,
) {
  const [sort, setSort] = useState<Sort<K>>(initial);
  const sorted = useMemo(() => {
    const get = keys[sort.key];
    const out = [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "en", { numeric: true, sensitivity: "base" });
      return sort.dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, keys, sort]);
  const toggle = (key: K) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };
  return { sorted, sort, toggle };
}

/** A column header that sorts its column (`aria-sort` on the header; the arrow shows on the active column). */
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (k: K) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`${listClass.th} ${className}`}
    >
      <button
        type="button"
        onClick={() => {
          onSort(column);
        }}
        className={`-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${active ? "text-foreground" : ""}`}
      >
        {label}
        {active ? <Arrow className="size-3.5" aria-hidden /> : <span className="inline-block size-3.5" aria-hidden />}
      </button>
    </th>
  );
}

/** Square checkbox (native input underneath, so it's keyboard and screen-reader correct). */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className="relative inline-flex size-4 items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        className="peer absolute inset-0 m-0 size-4 cursor-pointer appearance-none rounded-[4px] border border-foreground/40 bg-background checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      />
      {indeterminate ? (
        <Minus className="pointer-events-none relative size-3 text-primary-foreground" aria-hidden />
      ) : (
        checked && <Check className="pointer-events-none relative size-3 text-primary-foreground" aria-hidden />
      )}
    </span>
  );
}

/** Selected row ids for bulk actions; ids that leave the list drop out. */
export function useSelection(ids: readonly string[]) {
  const [picked, setPicked] = useState<string[]>([]);
  const selected = useMemo(() => picked.filter((id) => ids.includes(id)), [picked, ids]);
  const toggle = useCallback((id: string, on: boolean) => {
    setPicked((p) => (on ? [...p.filter((x) => x !== id), id] : p.filter((x) => x !== id)));
  }, []);
  const all = ids.length > 0 && ids.every((id) => selected.includes(id));
  const some = selected.length > 0 && !all;
  const toggleAll = (on: boolean) => {
    setPicked(on ? [...ids] : []);
  };
  const clear = useCallback(() => {
    setPicked([]);
  }, []);
  return { selected, toggle, toggleAll, all, some, clear };
}

/** Shown above the list while rows are selected: the count, the bulk actions and a clear button. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Selected items"
      className="flex flex-wrap items-center gap-1 rounded-lg border bg-accent/50 px-2 py-1"
    >
      <span className="am-num px-1.5 text-[14px] font-medium">{count} selected</span>
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      {children}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export type ChipOption<V extends string> = { value: V; label: string; count?: number };

/** Filter chips under the command bar: one choice at a time ("All" first). */
export function FilterChips<V extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ChipOption<V>[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted-foreground">{label}:</span>
      <div role="radiogroup" aria-label={`Filter by ${label.toLowerCase()}`} className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => {
              onChange(o.value);
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[13px] text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-checked:border-primary aria-checked:bg-primary/10 aria-checked:text-primary"
          >
            {o.label}
            {o.count !== undefined && <span className="am-num text-muted-foreground">{o.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export type RowMenuItem =
  | { label: string; icon?: ReactNode; href: string; danger?: boolean }
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean };

/**
 * The ⋮ menu beside a row's name. Fixed-positioned from its button (and following it on scroll) so the list's
 * scroll container can't clip it; Escape, an outside click or choosing an item closes it and focus goes back.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const place = useCallback(() => {
    if (!trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const width = 232;
    const height = panel.current?.offsetHeight ?? 160;
    const below = r.bottom + 4 + height < window.innerHeight;
    setPos({
      top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - height),
      left: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // Follow the button if the page scrolls or resizes.
    const onScroll = () => {
      place();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close, place]);

  if (items.length === 0) return <span className="inline-block size-8" aria-hidden />;
  const itemClass = (danger?: boolean) =>
    `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${danger ? "text-destructive" : ""}`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        <MoreVertical className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          ref={panel}
          className="fixed z-50"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
        >
          <PanelSurface>
            <div role="menu" aria-label={label} onKeyDown={menuKeys} className="flex w-[13.5rem] flex-col">
              {items.map((i) => {
                const icon = i.icon ? (
                  <span aria-hidden className="inline-flex text-muted-foreground [&>svg]:size-4">
                    {i.icon}
                  </span>
                ) : null;
                return "href" in i ? (
                  <Link
                    key={i.label}
                    role="menuitem"
                    href={i.href}
                    scroll={false}
                    onClick={() => {
                      close(false);
                    }}
                    className={itemClass(i.danger)}
                  >
                    {icon}
                    {i.label}
                  </Link>
                ) : (
                  <button
                    key={i.label}
                    type="button"
                    role="menuitem"
                    aria-disabled={i.disabled ? "true" : undefined}
                    onClick={() => {
                      if (i.disabled) return;
                      close(false);
                      i.onSelect();
                    }}
                    className={itemClass(i.danger)}
                  >
                    {icon}
                    {i.label}
                  </button>
                );
              })}
            </div>
          </PanelSurface>
        </div>
      )}
    </>
  );
}

/** "Nothing matches" / "No X yet" line inside a list area. */
export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="am-small border-b py-4">{children}</p>;
}
