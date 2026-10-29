// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Flag, Paperclip, Pin } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { WebmailPreferences } from "@anhourmail/shared/webmail";

import { Bone } from "@anhourmail/ui/skeletons";

import { PersonPhoto } from "../person-photo";

import { usePhoto } from "./avatars";
import { dateGroup, displayName, initials, relativeTime, subjectOf, tone } from "./format";
import type { ListRow } from "./mail-client";

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

/**
 * Square sender avatar: the profile photo of a mailbox in the same account (one of ours, same-origin and versioned —
 * never a remote image: privacy rule), else initials in a tone stable per address.
 */
export function SenderAvatar({
  email,
  label,
  size = "md",
}: {
  email: string | undefined;
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  const photo = usePhoto(email);
  const s = size === "lg" ? "size-10 text-[14px]" : size === "sm" ? "size-7 text-[11px]" : "size-9 text-[13px]";
  return (
    <PersonPhoto
      src={photo}
      label={label}
      className={`flex shrink-0 items-center justify-center rounded-md font-medium ${TONES[tone(email)] ?? TONES[0]} ${s}`}
    />
  );
}

/** How rows look (Settings → Appearance). */
export type ListLook = Pick<
  WebmailPreferences,
  "density" | "previewLines" | "senderFirst" | "avatars" | "attachmentChips" | "dateHeaders"
>;

const METRICS = {
  compact: { pad: 8, line: 18, preview: 16, primary: "text-[13px]", secondary: "text-[12.5px]", small: "text-[12px]" },
  comfortable: {
    pad: 12,
    line: 20,
    preview: 18,
    primary: "text-[14px]",
    secondary: "text-[13px]",
    small: "text-[12.5px]",
  },
  roomy: { pad: 16, line: 22, preview: 20, primary: "text-[15px]", secondary: "text-[14px]", small: "text-[13px]" },
} as const;
const CHIPS_HEIGHT = 30;

/** A row's height in px for a look (fixed per look, so the list can be windowed). Comfortable, 2 lines = 104. */
export function rowHeight(look: ListLook): number {
  const m = METRICS[look.density];
  return (
    m.pad * 2 +
    m.line * 2 +
    (look.previewLines > 0 ? 4 + look.previewLines * m.preview : 0) +
    (look.attachmentChips ? CHIPS_HEIGHT : 0)
  );
}

/** Attachment names to show as chips (named parts only; inline images without a name are skipped). */
const chipNames = (row: ListRow) =>
  (row.attachments ?? []).map((a) => a.name?.trim() ?? "").filter((n): n is string => n !== "");

export function MessageRow({
  row,
  index,
  selected,
  checked,
  selecting,
  sentFolder,
  look,
  onOpen,
  onCheck,
}: {
  row: ListRow;
  index: number;
  selected: boolean;
  checked: boolean;
  selecting: boolean;
  sentFolder: boolean;
  look: ListLook;
  onOpen: (index: number) => void;
  onCheck: (index: number, range: boolean) => void;
}) {
  const m = METRICS[look.density];
  const unread = row.keywords.$seen !== true;
  const flagged = row.keywords.$flagged === true;
  const pinned = row.keywords.$pinned === true;
  const who = sentFolder ? row.to?.[0] : row.from?.[0];
  const name = sentFolder ? `To ${displayName(who)}` : displayName(who);
  const subject = subjectOf(row.subject);
  const chips = look.attachmentChips ? chipNames(row) : [];
  const first = look.senderFirst ? name : subject;
  const second = look.senderFirst ? subject : name;
  const avatarSize = look.density === "compact" ? "sm" : "md";
  const box = look.avatars ? (look.density === "compact" ? "size-7" : "size-9") : "w-5 h-9";
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
      style={{ paddingTop: m.pad, paddingBottom: m.pad }}
      className={`group relative flex h-full cursor-pointer gap-3 border-b px-3 outline-none transition-colors ${
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
        className={`relative shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring ${box}`}
      >
        {/* The avatar square becomes a checkbox on hover, and stays one while anything is selected. */}
        {look.avatars && (
          <span className={checked || selecting ? "hidden" : "group-hover:hidden"}>
            <SenderAvatar email={who?.email} label={initials(who)} size={avatarSize} />
          </span>
        )}
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
        <div className="flex items-center gap-2" style={{ height: m.line }}>
          <span
            className={`min-w-0 truncate ${m.primary} ${unread ? "font-medium text-foreground" : "text-foreground/80"}`}
            style={{ lineHeight: `${String(m.line)}px` }}
          >
            {first}
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
        <div className="flex items-center gap-1.5" style={{ height: m.line }}>
          <span
            className={`min-w-0 flex-1 truncate ${m.secondary} ${unread ? "font-medium text-foreground" : "text-foreground/75"}`}
            style={{ lineHeight: `${String(m.line)}px` }}
          >
            {second}
          </span>
          {pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {row.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {flagged && (
            <Flag className="size-3.5 shrink-0 fill-current text-[rgb(var(--am-status-warning-bg))]" aria-hidden />
          )}
        </div>
        {look.previewLines > 0 && (
          <p
            className={`mt-1 overflow-hidden text-muted-foreground ${m.small} ${look.previewLines === 1 ? "line-clamp-1" : "line-clamp-2"}`}
            style={{ lineHeight: `${String(m.preview)}px` }}
          >
            {row.preview}
          </p>
        )}
        {look.attachmentChips && (
          <div className="mt-1.5 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden" aria-label="Attachments">
            {chips.slice(0, 3).map((n, i) => (
              <span
                key={`${n}-${String(i)}`}
                className="inline-flex h-6 max-w-40 items-center gap-1 rounded-md border bg-background px-1.5 text-[11.5px] text-muted-foreground"
              >
                <Paperclip className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{n}</span>
              </span>
            ))}
            {chips.length > 3 && <span className="text-[11.5px] text-muted-foreground">+{chips.length - 3}</span>}
          </div>
        )}
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
 * Where each main row sits when date headers are on: a header goes above a loaded row whose group differs from the
 * loaded row before it (rows not loaded yet continue the group above them). `before[i]` = headers above row i.
 */
function headerLayout(rows: readonly (ListRow | undefined)[], total: number, on: boolean) {
  const before = new Int32Array(Math.max(total, 1));
  const labels = new Map<number, string>();
  if (!on) return { before, labels };
  let prev: string | null = null;
  let count = 0;
  const now = new Date();
  for (let i = 0; i < total; i++) {
    before[i] = count;
    const row = rows[i];
    if (!row) continue;
    const g = dateGroup(row.receivedAt, now);
    if (g !== prev && (i === 0 || rows[i - 1] !== undefined)) {
      labels.set(i, g);
      count += 1;
    }
    prev = g;
  }
  return { before, labels };
}

/**
 * The list: an optional "Pinned" section (rendered in full, ≤ 50) and the main section, windowed so only the rows
 * in view (plus overscan) are in the DOM — a 10k-message folder stays at a few dozen nodes (05-webmail.md budgets).
 * Indexes are flat: pinned rows first, then the main rows. Row height follows the chosen look; date headers (a
 * setting) sit between main rows.
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
  look,
  rowKey,
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
  look: ListLook;
  /** The key a row is selected by (its conversation, or the message itself when not grouping). */
  rowKey: (row: ListRow) => string;
  onOpen: (index: number) => void;
  onCheck: (index: number, range: boolean) => void;
  onRange: (start: number, end: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 900 });
  const rh = rowHeight(look);
  const showSections = pinned.length > 0;
  const pinnedTop = SECTION_HEIGHT;
  const mainTop = showSections ? SECTION_HEIGHT + pinned.length * rh + SECTION_HEIGHT : 0;
  const { before, labels } = useMemo(
    () => headerLayout(rows, total, look.dateHeaders),
    [rows, total, look.dateHeaders],
  );
  /** Top of main row i (below its own date header, if it has one). */
  const rowTop = useCallback(
    (i: number) => mainTop + i * rh + ((before[i] ?? 0) + (labels.has(i) ? 1 : 0)) * SECTION_HEIGHT,
    [mainTop, rh, before, labels],
  );

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

  /** The first main row whose bottom is below `y` (binary search over the monotonic row tops). */
  const indexAt = (y: number) => {
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowTop(mid) + rh <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = Math.max(0, indexAt(view.top) - OVERSCAN);
  const end = Math.min(total, indexAt(view.top + view.height) + 1 + OVERSCAN);

  useEffect(() => {
    onRange(start, end);
  }, [start, end, onRange]);

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || selectedIndex === null) return;
    const top = selectedIndex < pinned.length ? pinnedTop + selectedIndex * rh : rowTop(selectedIndex - pinned.length);
    const above = showSections || labels.has(selectedIndex - pinned.length) ? SECTION_HEIGHT : 0;
    if (top - above < el.scrollTop) el.scrollTop = Math.max(0, top - above);
    else if (top + rh > el.scrollTop + el.clientHeight) el.scrollTop = top + rh - el.clientHeight;
  }, [selectedIndex, pinned.length, pinnedTop, rh, rowTop, labels, showSections]);

  const selecting = checked.size > 0;
  const rowProps = (row: ListRow, index: number) => ({
    row,
    index,
    selected: index === selectedIndex,
    checked: checked.has(rowKey(row)),
    selecting,
    sentFolder,
    look,
    onOpen,
    onCheck,
  });

  const items = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const top = rowTop(i);
    const header = labels.get(i);
    if (header) {
      items.push(
        <div
          key={`h-${String(i)}`}
          role="presentation"
          className="absolute inset-x-0 flex items-end px-3 pb-1.5 font-medium text-[12px] text-muted-foreground"
          style={{ top: top - SECTION_HEIGHT, height: SECTION_HEIGHT }}
        >
          {header}
        </div>,
      );
    }
    items.push(
      <div key={row?.id ?? `pending-${String(i)}`} className="absolute inset-x-0" style={{ top, height: rh }}>
        {row ? <MessageRow {...rowProps(row, pinned.length + i)} /> : <RowSkeleton />}
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
      data-density={look.density}
      tabIndex={0}
      onScroll={(e) => {
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
      }}
      // Room at the end on phones and tablets so the last row scrolls clear of the floating New email button.
      className="relative min-h-0 flex-1 overflow-y-auto pb-20 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:pb-0"
    >
      <div className="relative" style={{ height: total > 0 ? rowTop(total - 1) + rh : mainTop }}>
        {showSections && (
          <>
            <SectionLabel label="Pinned" count={pinned.length} top={0} />
            {pinned.map((row, i) => (
              <div key={`p-${row.id}`} className="absolute inset-x-0" style={{ top: pinnedTop + i * rh, height: rh }}>
                <MessageRow {...rowProps(row, i)} />
              </div>
            ))}
            <SectionLabel label={sectionLabel} count={total} top={pinnedTop + pinned.length * rh} />
          </>
        )}
        {items}
      </div>
    </div>
  );
}
