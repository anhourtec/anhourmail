// SPDX-License-Identifier: AGPL-3.0-only
import { Filter } from "lucide-react";

import { inputClass, primaryButtonClass } from "../ui-classes";

export type FilterOption = { value: string; label: string };

/**
 * Plain GET form (works without JavaScript): area, who, result and a UTC date range. Applying it starts again from
 * the newest entry.
 */
export function AuditFilters({
  action,
  areas,
  actors,
  current,
}: {
  action: string;
  areas: FilterOption[];
  actors: FilterOption[];
  current: { area?: string; actor?: string; result?: string; from?: string; to?: string };
}) {
  const active = Object.values(current).some((v) => v !== "");
  return (
    <form method="get" action={action} className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-area" className="am-h4">
            Area
          </label>
          <select id="audit-area" name="area" defaultValue={current.area ?? ""} className={inputClass}>
            <option value="">Everything</option>
            {areas.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-actor" className="am-h4">
            Who
          </label>
          <select id="audit-actor" name="actor" defaultValue={current.actor ?? ""} className={inputClass}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-result" className="am-h4">
            Result
          </label>
          <select id="audit-result" name="result" defaultValue={current.result ?? ""} className={inputClass}>
            <option value="">Any result</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-from" className="am-h4">
            From (UTC)
          </label>
          <input
            type="date"
            id="audit-from"
            name="from"
            defaultValue={current.from ?? ""}
            className={`${inputClass} am-num`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-to" className="am-h4">
            To (UTC)
          </label>
          <input
            type="date"
            id="audit-to"
            name="to"
            defaultValue={current.to ?? ""}
            className={`${inputClass} am-num`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryButtonClass}>
          <Filter className="size-4" aria-hidden />
          Apply filters
        </button>
        {active && (
          <a href={action} className="am-small underline underline-offset-2 hover:text-foreground">
            Clear filters
          </a>
        )}
      </div>
    </form>
  );
}
