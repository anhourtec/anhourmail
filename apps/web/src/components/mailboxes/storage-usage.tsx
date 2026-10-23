// SPDX-License-Identifier: AGPL-3.0-only
import { type StorageLevel, storageSummary } from "@anhourmail/shared/storage";

import { StatusText } from "../console/status-text";

/** Bar fill per level, from the status tokens (amber at 80%, red at 95%); the words beside it say the same. */
const FILL: Record<StorageLevel, string> = {
  unknown: "bg-transparent",
  ok: "bg-primary",
  warning: "bg-[rgb(var(--am-status-warning-bg))]",
  critical: "bg-[rgb(var(--am-status-danger-bg))]",
  full: "bg-[rgb(var(--am-status-danger-bg))]",
};

/** A thin usage bar. Decorative: the text next to it carries the numbers and the level. */
export function UsageBar({
  fraction,
  level,
  className = "",
}: {
  fraction: number | null;
  level: StorageLevel;
  className?: string;
}) {
  // A sliver stays visible for a little mail, so "<1%" isn't an empty bar.
  const width = fraction === null ? 0 : fraction === 0 ? 0 : Math.max(2, Math.round(fraction * 100));
  return (
    <div aria-hidden className={`h-1.5 w-full overflow-hidden rounded-full bg-border ${className}`}>
      <div className={`h-full rounded-full ${FILL[level]}`} style={{ width: `${String(width)}%` }} />
    </div>
  );
}

/** "Getting full" / "Almost full" / "Full" with its icon, or nothing below 80%. */
export function StorageLevelText({ level, label }: { level: StorageLevel; label: string | null }) {
  if (!label) return null;
  return (
    <StatusText tone={level === "warning" ? "warning" : "danger"} className="text-[13px]">
      {label}
    </StatusText>
  );
}

/** "1.2 GB of 10 GB" in mono numbers; "— of 10 GB" until the first measurement. */
export function UsedOfQuota({ usedBytes, quotaBytes }: { usedBytes: number | null; quotaBytes: number }) {
  const s = storageSummary(usedBytes, quotaBytes);
  return (
    <span>
      {s.used === null ? (
        <span title="Not measured yet">
          <span aria-hidden>—</span>
          <span className="sr-only">Not measured yet,</span>
        </span>
      ) : (
        <span className="am-num">{s.used}</span>
      )}{" "}
      of <span className="am-num">{s.quota}</span>
    </span>
  );
}

/** The list cell: used of quota, the bar, and the level in words when it's getting full. */
export function StorageCell({ usedBytes, quotaBytes }: { usedBytes: number | null; quotaBytes: number }) {
  const s = storageSummary(usedBytes, quotaBytes);
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <span className="text-[14px] whitespace-nowrap">
        <UsedOfQuota usedBytes={usedBytes} quotaBytes={quotaBytes} />
      </span>
      {s.level !== "unknown" && <UsageBar fraction={s.fraction} level={s.level} className="max-w-40" />}
      <StorageLevelText level={s.level} label={s.label} />
    </div>
  );
}
