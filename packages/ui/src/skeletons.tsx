// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { cn } from "./cn";

/**
 * Loading skeletons that mirror the real layouts (CLAUDE.md rule 11).
 * Built on .am-skeleton (shimmer, off under reduced motion, light + dark).
 * Server components — safe to use in loading.tsx files.
 */

export function Bone({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("am-skeleton", className)} />;
}

/** Wrapper that tells assistive tech something is loading. */
export function SkeletonPage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Mirrors PageHeader: breadcrumb, large title, optional one-line description (+ actions at the title's right). */
export function PageHeaderSkeleton({
  actions = 0,
  lead = true,
  breadcrumbs = true,
}: {
  actions?: number;
  lead?: boolean;
  breadcrumbs?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {breadcrumbs && <Bone className="h-3.5 w-36" />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Bone className="h-9 w-64 max-w-full" />
        {actions > 0 && (
          <div className="flex gap-2">
            {Array.from({ length: actions }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Bone key={i} className="h-9 w-28" />
            ))}
          </div>
        )}
      </div>
      {lead && <Bone className="h-3.5 w-96 max-w-full" />}
    </div>
  );
}

/** Mirrors the console command bar: a hairline, icon + text actions on the left, a search box on the right. */
export function CommandBarSkeleton({ actions = 2, search = true }: { actions?: number; search?: boolean }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-t pt-2">
      {Array.from({ length: actions }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Bone key={i} className="h-8 w-32" />
      ))}
      {search && <Bone className="ml-auto h-8 w-full sm:w-60" />}
    </div>
  );
}

/** Mirrors the filter chips row under the command bar. */
export function FilterChipsSkeleton({ chips = 3 }: { chips?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Bone className="h-3.5 w-12" />
      {Array.from({ length: chips }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Bone key={i} className="h-7 w-20 rounded-full" />
      ))}
    </div>
  );
}

/** Mirrors the console lists: optional checkbox column, a bold primary column, secondary columns, ~46 px rows. */
export function ListSkeleton({
  rows = 6,
  columns = 3,
  checkbox = false,
}: {
  rows?: number;
  columns?: number;
  checkbox?: boolean;
}) {
  return (
    <div className="overflow-hidden">
      <div className="flex h-10 items-center gap-6 border-b px-3">
        {checkbox && <Bone className="size-4 shrink-0 rounded" />}
        <Bone className="h-3 w-24" />
        {Array.from({ length: Math.max(columns - 1, 0) }, (_, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Bone key={c} className={cn("h-3 w-16", c > 0 && "hidden sm:block")} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={r} className="flex h-[46px] items-center gap-6 border-b px-3">
          {checkbox && <Bone className="size-4 shrink-0 rounded" />}
          <Bone className="h-3.5 w-44 max-w-[50%]" />
          {Array.from({ length: Math.max(columns - 1, 0) }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Bone key={c} className={cn("h-3.5 w-24", c > 0 && "hidden sm:block")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Mirrors the flyout details panel body: initials circle, name, status, action links, tabs, two-column fields. */
export function DetailPanelSkeleton({ fields = 6 }: { fields?: number }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-5">
        <Bone className="size-16 shrink-0 rounded-full sm:size-24" />
        <div className="flex flex-col gap-2.5">
          <Bone className="h-6 w-56 max-w-full" />
          <Bone className="h-3.5 w-24" />
          <Bone className="h-3.5 w-64 max-w-full" />
        </div>
      </div>
      <div className="flex gap-5 border-b pb-2">
        <Bone className="h-4 w-16" />
        <Bone className="h-4 w-20" />
        <Bone className="h-4 w-14" />
      </div>
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-4 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Four KPI cards. */
export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="rounded-xl border bg-card p-5">
          <Bone className="size-8 rounded-lg" />
          <Bone className="mt-3 h-3.5 w-24" />
          <Bone className="mt-3 h-8 w-20" />
          <Bone className="mt-3 h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

/** A chart card. */
export function ChartSkeleton({ height = "h-72", className }: { height?: string; className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-5", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Bone className="h-5 w-28" />
          <Bone className="h-3.5 w-64 max-w-full" />
        </div>
        <Bone className="h-7 w-40" />
      </div>
      <Bone className={cn("mt-4 w-full rounded-lg", height)} />
    </div>
  );
}

/** The shared DataTable: toolbar, header row, body rows, pagination. */
export function TableSkeleton({
  rows = 6,
  columns = 5,
  title = true,
}: {
  rows?: number;
  columns?: number;
  title?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {title ? <Bone className="h-6 w-44" /> : <span />}
        <div className="flex gap-2">
          <Bone className="h-7 w-56" />
          <Bone className="h-7 w-24" />
          <Bone className="h-7 w-28" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border">
        <div className="flex h-11 items-center gap-6 border-b px-3">
          {Array.from({ length: columns }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Bone key={i} className={cn("h-3.5", i === 0 ? "w-40" : "w-20")} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <div key={r} className="flex h-14 items-center gap-6 border-b px-3 last:border-0">
            <Bone className="size-8 shrink-0 rounded-full" />
            <div className="flex w-40 flex-col gap-1.5">
              <Bone className="h-3.5 w-32" />
              <Bone className="h-3 w-24" />
            </div>
            {Array.from({ length: Math.max(columns - 2, 1) }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Bone key={c} className="h-3.5 w-20" />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Bone className="h-7 w-40" />
        <Bone className="h-8 w-44" />
      </div>
    </div>
  );
}

/** Tabs row (org detail). */
export function TabsSkeleton({ tabs = 4 }: { tabs?: number }) {
  return (
    <div className="flex gap-2">
      {Array.from({ length: tabs }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Bone key={i} className="h-8 w-24" />
      ))}
    </div>
  );
}

/** A long block of text (agreement / article). */
export function TextBlockSkeleton({ lines = 14, boxed = true }: { lines?: number; boxed?: boolean }) {
  const widths = ["w-full", "w-11/12", "w-10/12", "w-full", "w-9/12", "w-full", "w-8/12"];
  return (
    <div className={cn("flex flex-col gap-3", boxed && "rounded-xl border bg-card p-6 sm:p-8")}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Bone key={i} className={cn("h-3.5", widths[i % widths.length], i % 6 === 5 && "mb-3")} />
      ))}
    </div>
  );
}

/** Label + input pairs. */
export function FormSkeleton({ fields = 3, button = true }: { fields?: number; button?: boolean }) {
  return (
    <div className="flex max-w-lg flex-col gap-5">
      {Array.from({ length: fields }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex flex-col gap-2">
          <Bone className="h-3.5 w-24" />
          <Bone className="h-9 w-full" />
        </div>
      ))}
      {button && <Bone className="h-7 w-32" />}
    </div>
  );
}

/** Docs: nav tree + article + "on this page". */
export function DocsSkeleton() {
  return (
    <div className="grid w-full grid-cols-1 gap-x-10 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_14rem]">
      <div className="mb-6 flex flex-col gap-3 lg:hidden">
        <Bone className="h-9 w-full rounded-lg" />
        <Bone className="h-9 w-full rounded-lg" />
      </div>
      <div className="hidden flex-col gap-3 lg:flex">
        <Bone className="mb-2 h-9 w-full rounded-lg" />
        <Bone className="h-4 w-36" />
        {Array.from({ length: 12 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Bone key={i} className={cn("h-3.5", i % 4 === 0 ? "mt-2 w-24" : "ml-4 w-36")} />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <Bone className="h-9 w-80 max-w-full" />
        <Bone className="mt-4 h-px w-full" />
        <Bone className="mt-4 h-6 w-48" />
        <TextBlockSkeleton lines={10} boxed={false} />
      </div>
      <div className="hidden flex-col gap-3 xl:flex">
        <Bone className="h-3 w-24" />
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Bone key={i} className="h-3 w-28" />
        ))}
      </div>
    </div>
  );
}

/** Centred auth card: eyebrow, title, fields, button. */
export function AuthSkeleton({ fields = 2, wide = false }: { fields?: number; wide?: boolean }) {
  return (
    <div role="status" aria-busy="true" className={cn("w-full", wide ? "max-w-3xl" : "max-w-sm")}>
      <span className="sr-only">Loading</span>
      <Bone className="h-3 w-28" />
      <Bone className="mt-4 h-8 w-64 max-w-full" />
      <Bone className="mt-3 h-4 w-72 max-w-full" />
      <div className="mt-8 flex flex-col gap-5">
        {wide ? (
          <TextBlockSkeleton lines={12} />
        ) : (
          Array.from({ length: fields }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex flex-col gap-2">
              <Bone className="h-3.5 w-20" />
              <Bone className="h-9 w-full" />
            </div>
          ))
        )}
        <Bone className="h-9 w-full" />
      </div>
    </div>
  );
}

/* ---- mail ---------------------------------------------------------------------------------------- */

/** Webmail folder sidebar: compose button + folder rows. */
export function FolderTreeSkeleton({ folders = 7 }: { folders?: number }) {
  return (
    <div className="flex flex-col gap-1 p-3">
      <Bone className="mb-3 h-9 w-full rounded-lg" />
      {Array.from({ length: folders }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex h-8 items-center gap-3 px-2">
          <Bone className="size-4 rounded" />
          <Bone className="h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Message list rows: square avatar, sender + time, subject, two preview lines — same 104px height as a real row. */
export function MessageListSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex h-[104px] gap-3 border-b px-3 py-3">
          <Bone className="size-9 shrink-0 rounded-md" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <div className="flex items-center justify-between gap-4">
              <Bone className="h-3.5 w-32" />
              <Bone className="h-3 w-16" />
            </div>
            <Bone className="h-3.5 w-3/4" />
            <Bone className="h-3 w-11/12" />
            <Bone className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Reading pane: subject, sender block, body lines. */
export function ReaderSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Bone className="h-7 w-2/3" />
      <div className="flex items-center gap-3">
        <Bone className="size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <Bone className="h-3.5 w-48" />
          <Bone className="h-3 w-32" />
        </div>
      </div>
      <TextBlockSkeleton lines={12} boxed={false} />
    </div>
  );
}
