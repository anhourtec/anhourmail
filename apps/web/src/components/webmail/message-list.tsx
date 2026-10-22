// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Flag, Paperclip, Pin } from "lucide-react";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";

import { displayName, initials, relativeTime, subjectOf, tone } from "./format";
import type { ListRow } from "./mail-client";

/** Row height in px; `MessageListSkeleton` rows use the same height. */
export const ROW_HEIGHT = 104;
/** Section label ("Pinned (4)", "Inbox (13)") height in px. */
export const SECTION_HEIGHT = 30;
const OVERSCAN = 6;

export const TONES = [
  "bg-chart-1/14 text-chart-1",
  "bg-chart-2/16 text-chart-2",
  "bg-chart-3/16 text-chart-3",
  "bg-chart-4/14 text-chart-4",
  "bg-chart-5/16 text-chart-5",
];

/** Square initial avatar (no remote images: privacy rule). */
export function SenderAvatar({
  email,
  label,
  size = "md",
}: {
  email: string | undefined;
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  const s = size === "lg" ? "size-10 text-[14px]" : size === "sm" ? "size-7 text-[11px]" : "size-9 text-[13px]";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-md font-medium ${TONES[tone(email)] ?? TONES[0]} ${s}`}
    >
      {label}
    </span>
  );
}

function Row({
  row,
  index,
  selected,
  checked,
  selecting,
  sentFolder,
  onOpen,
  onCheck,
}: {
  row: ListRow;
  index: number;
  selected: boolean;
  checked: boolean;
  selecting: boolean;
  sentFolder: boolean;
  onOpen: (index: number) => void;
  onCheck: (index: number, range: boolean) => void;
}) {
  const unread = row.keywords.$seen !== true;
  const flagged = row.keywords.$flagged === true;
  const pinned = row.keywords.$pinned === true;
  const who = sentFolder ? row.to?.[0] : row.from?.[0];
  const name = sentFolder ? `To ${displayName(who)}` : displayName(who);
  const subject = subjectOf(row.subject);
  return (
    <div
      role="option"
      id={`msg-${row.id}`}
      aria-selected={selected}
      aria-label={`${unread ? "Unread. " : ""}${pinned ? "Pinned. " : ""}${flagged ? "Flagged. " : ""}${name}: ${subject}`}
      tabIndex={-1}
      data-row-index={index}
      onClick={(e: MouseEvent) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey || selecting) onCheck(index, e.shiftKey);
        else onOpen(index);
      }}
      className={`group relative flex h-full cursor-pointer gap-3 border-b px-3 py-3 outline-none transition-colors ${
        checked ? "bg-primary/8" : selected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`Select ${subject}`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onCheck(index, e.shiftKey);
        }}
        className="relative size-9 shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* The avatar square becomes a checkbox on hover, and stays one while anything is selected. */}
        <span className={checked || selecting ? "hidden" : "group-hover:hidden"}>
          <SenderAvatar email={who?.email} label={initials(who)} />
        </span>
        <span
          aria-hidden
          className={`absolute inset-0 items-center justify-center ${checked || selecting ? "flex" : "hidden group-hover:flex"}`}
        >
          <span
            className={`flex size-5 items-center justify-center rounded-[5px] border-2 transition-colors ${
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground/70 bg-background hover:border-foreground"
            }`}
          >
            {checked && <Check className="size-3.5" strokeWidth={3.5} />}
          </span>
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-5 items-center gap-2">
          <span
            className={`min-w-0 truncate text-[14px] leading-5 ${unread ? "font-medium text-foreground" : "text-foreground/80"}`}
          >
            {name}
          </span>
          {unread && <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />}
          {row.threadSize > 1 && (
            <span className="rounded border px-1 font-mono text-[10.5px] text-muted-foreground tabular-nums">
              {row.threadSize}
            </span>
          )}
          <span className="flex-1" />
          <span
            className={`shrink-0 text-[11.5px] tabular-nums ${selected ? "text-foreground" : "text-muted-foreground"}`}
          >
            {relativeTime(row.receivedAt)}
          </span>
        </div>
        <div className="flex h-5 items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${unread ? "font-medium text-foreground" : "text-foreground/75"}`}
          >
            {subject}
          </span>
          {pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {row.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {flagged && (
            <Flag className="size-3.5 shrink-0 fill-current text-[rgb(var(--am-status-warning-bg))]" aria-hidden />
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground leading-[18px]">{row.preview}</p>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-full gap-3 border-b px-3 py-3">
      <Bone className="size-9 shrink-0 rounded-md" />
      <div className="flex flex-1 flex-col gap-2 pt-0.5">
        <div className="flex justify-between gap-4">
          <Bone className="h-3.5 w-32" />
          <Bone className="h-3 w-16" />
        </div>
        <Bone className="h-3.5 w-3/4" />
        <Bone className="h-3 w-11/12" />
        <Bone className="h-3 w-2/3" />
      </div>
    </div>
  );
}

function SectionLabel({ label, count, top }: { label: string; count: number; top: number }) {
  return (
    <div
      className="absolute inset-x-0 flex items-end px-3 pb-1.5 text-[12px] text-muted-foreground"
      style={{ top, height: SECTION_HEIGHT }}
    >
      {label} ({count})
    </div>
  );
}

/**
 * The list: an optional "Pinned" section (rendered in full, ≤ 50) and the main section, windowed so only the rows
 * in view (plus overscan) are in the DOM — a 10k-message folder stays at a few dozen nodes (05-webmail.md budgets).
 * Indexes are flat: pinned rows first, then the main rows.
 */
export function MessageList({
  pinned,
  total,
  rows,
  sectionLabel,
  selectedIndex,
  checked,
  sentFolder,
  label,
  onOpen,
  onCheck,
  onRange,
}: {
  pinned: ListRow[];
  total: number;
  rows: (ListRow | undefined)[];
  sectionLabel: string;
  selectedIndex: number | null;
  checked: ReadonlySet<string>;
  sentFolder: boolean;
  label: string;
  onOpen: (index: number) => void;
  onCheck: (index: number, range: boolean) => void;
  onRange: (start: number, end: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 900 });
  const showSections = pinned.length > 0;
  const pinnedTop = SECTION_HEIGHT;
  const mainTop = showSections ? SECTION_HEIGHT + pinned.length * ROW_HEIGHT + SECTION_HEIGHT : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setView({ top: el.scrollTop, height: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const start = Math.max(0, Math.floor((view.top - mainTop) / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.max(0, Math.ceil((view.top + view.height - mainTop) / ROW_HEIGHT)) + OVERSCAN);

  useEffect(() => {
    onRange(start, end);
  }, [start, end, onRange]);

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || selectedIndex === null) return;
    const top =
      selectedIndex < pinned.length
        ? pinnedTop + selectedIndex * ROW_HEIGHT
        : mainTop + (selectedIndex - pinned.length) * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - (showSections ? SECTION_HEIGHT : 0));
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selectedIndex, pinned.length, mainTop, pinnedTop, showSections]);

  const selecting = checked.size > 0;
  const rowProps = (row: ListRow, index: number) => ({
    row,
    index,
    selected: index === selectedIndex,
    checked: checked.has(row.threadId),
    selecting,
    sentFolder,
    onOpen,
    onCheck,
  });

  const items = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    items.push(
      <div
        key={row?.id ?? `pending-${String(i)}`}
        className="absolute inset-x-0"
        style={{ top: mainTop + i * ROW_HEIGHT, height: ROW_HEIGHT }}
      >
        {row ? <Row {...rowProps(row, pinned.length + i)} /> : <RowSkeleton />}
      </div>,
    );
  }

  const selected =
    selectedIndex === null
      ? undefined
      : selectedIndex < pinned.length
        ? pinned[selectedIndex]
        : rows[selectedIndex - pinned.length];
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      aria-activedescendant={selected ? `msg-${selected.id}` : undefined}
      tabIndex={0}
      onScroll={(e) => {
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
      }}
      className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="relative" style={{ height: mainTop + total * ROW_HEIGHT }}>
        {showSections && (
          <>
            <SectionLabel label="Pinned" count={pinned.length} top={0} />
            {pinned.map((row, i) => (
              <div
                key={`p-${row.id}`}
                className="absolute inset-x-0"
                style={{ top: pinnedTop + i * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <Row {...rowProps(row, i)} />
              </div>
            ))}
            <SectionLabel label={sectionLabel} count={total} top={pinnedTop + pinned.length * ROW_HEIGHT} />
          </>
        )}
        {items}
      </div>
    </div>
  );
}
