// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Flag, Paperclip } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";

import { displayName, initials, listDate, subjectOf, tone } from "./format";
import type { ListRow } from "./mail-client";

/** Row height in px; MessageListSkeleton rows use the same 76px. */
export const ROW_HEIGHT = 76;
const OVERSCAN = 8;

export const TONES = [
  "bg-chart-1/14 text-chart-1",
  "bg-chart-2/16 text-chart-2",
  "bg-chart-3/16 text-chart-3",
  "bg-chart-4/14 text-chart-4",
  "bg-chart-5/16 text-chart-5",
];

export function SenderAvatar({
  email,
  label,
  size = "md",
}: {
  email: string | undefined;
  label: string;
  size?: "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${TONES[tone(email)] ?? TONES[0]} ${
        size === "lg" ? "size-10 text-[14px]" : "size-8 text-[12px]"
      }`}
    >
      {label}
    </span>
  );
}

function Row({
  row,
  index,
  total,
  selected,
  sentFolder,
  onOpen,
}: {
  row: ListRow;
  index: number;
  total: number;
  selected: boolean;
  sentFolder: boolean;
  onOpen: (index: number) => void;
}) {
  const unread = row.keywords.$seen !== true;
  const flagged = row.keywords.$flagged === true;
  const who = sentFolder ? row.to?.[0] : row.from?.[0];
  const name = sentFolder ? `To ${displayName(who)}` : displayName(who);
  return (
    <div
      role="option"
      id={`msg-${row.id}`}
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={`${unread ? "Unread. " : ""}${flagged ? "Flagged. " : ""}${name}: ${subjectOf(row.subject)}`}
      tabIndex={-1}
      onClick={() => {
        onOpen(index);
      }}
      className={`group relative flex h-full cursor-pointer gap-3 border-b px-4 py-2.5 outline-none transition-colors ${
        selected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <div className="relative pt-0.5">
        <SenderAvatar email={who?.email} label={initials(who)} />
        {unread && <span aria-hidden className="-left-2.5 absolute top-3 size-1.5 rounded-full bg-primary" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[14px] leading-5 ${unread ? "font-medium text-foreground" : "text-foreground/80"}`}
          >
            {name}
          </span>
          {row.threadSize > 1 && (
            <span className="rounded-md border px-1 font-mono text-[11px] text-muted-foreground tabular-nums">
              {row.threadSize}
            </span>
          )}
          <span
            className={`shrink-0 font-mono text-[11.5px] tabular-nums ${unread ? "text-primary" : "text-muted-foreground"}`}
          >
            {listDate(row.receivedAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-[13.5px] leading-[19px] ${unread ? "font-medium text-foreground" : "text-foreground/75"}`}
          >
            {subjectOf(row.subject)}
          </span>
          {row.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {flagged && (
            <Flag className="size-3.5 shrink-0 fill-current text-[rgb(var(--am-status-warning-bg))]" aria-hidden />
          )}
        </div>
        <p className="truncate text-[12.5px] leading-[17px] text-muted-foreground">{row.preview}</p>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-full gap-3 border-b px-4 py-2.5">
      <Bone className="size-8 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col justify-center gap-2">
        <div className="flex justify-between gap-4">
          <Bone className="h-3.5 w-32" />
          <Bone className="h-3 w-10" />
        </div>
        <Bone className="h-3.5 w-3/4" />
        <Bone className="h-3 w-11/12" />
      </div>
    </div>
  );
}

/**
 * Windowed message list: only the rows in view (plus overscan) are in the DOM, so a 10k-message folder stays at
 * a few dozen nodes (05-webmail.md budgets). Asks for missing windows through `onRange`.
 */
export function MessageList({
  total,
  rows,
  selectedIndex,
  sentFolder,
  label,
  onOpen,
  onRange,
}: {
  total: number;
  rows: (ListRow | undefined)[];
  selectedIndex: number | null;
  sentFolder: boolean;
  label: string;
  onOpen: (index: number) => void;
  onRange: (start: number, end: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 900 });

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

  const start = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    onRange(start, end);
  }, [start, end, onRange]);

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || selectedIndex === null) return;
    const top = selectedIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selectedIndex]);

  const items = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    items.push(
      <div
        key={row?.id ?? `pending-${String(i)}`}
        className="absolute inset-x-0"
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
      >
        {row ? (
          <Row
            row={row}
            index={i}
            total={total}
            selected={i === selectedIndex}
            sentFolder={sentFolder}
            onOpen={onOpen}
          />
        ) : (
          <RowSkeleton />
        )}
      </div>,
    );
  }

  const selected = selectedIndex !== null ? rows[selectedIndex] : undefined;
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      aria-activedescendant={selected ? `msg-${selected.id}` : undefined}
      tabIndex={0}
      onScroll={(e) => {
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
      }}
      className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="relative" style={{ height: total * ROW_HEIGHT }}>
        {items}
      </div>
    </div>
  );
}
