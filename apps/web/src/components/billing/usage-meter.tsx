// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One usage line on the Billing page: what's used of what the plan allows, as figures and a thin bar. At 90% or more
 * the figure and the bar turn the warning colour. A plain server component (no client state).
 */
export function UsageMeter({
  label,
  used,
  limit,
  usedText = String(used),
  limitText = String(limit),
}: {
  label: string;
  used: number;
  limit: number;
  usedText?: string;
  limitText?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const near = pct >= 90;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="am-num text-[17px] font-medium">
          {usedText} <span className="am-small">of {limitText}</span>
        </span>
        <span
          className={`am-num text-[13px] ${near ? "text-[rgb(var(--am-status-warning))]" : "text-muted-foreground"}`}
        >
          {pct}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${usedText} of ${limitText}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${near ? "bg-[rgb(var(--am-status-warning))]" : "bg-primary"}`}
          style={{ width: `${String(used > 0 ? Math.max(pct, 2) : 0)}%` }}
        />
      </div>
      <span className="am-small">{label}</span>
    </div>
  );
}
