// SPDX-License-Identifier: AGPL-3.0-only
import { Filter, X } from "lucide-react";

export type FilterOption = { value: string; label: string };

const chip =
  "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background pr-1 pl-3 text-[13px] focus-within:ring-2 focus-within:ring-ring has-[option:checked:not([value=''])]:border-primary";
const control = "h-7 max-w-44 bg-transparent pr-1 text-[13px] text-foreground outline-none";

/**
 * The audit log's filter chips (console page template): area, who, result and a UTC date range, as one plain GET
 * form (works without JavaScript). Applying it starts again from the newest entry.
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
    <form method="get" action={action} className="flex flex-wrap items-center gap-2" aria-label="Filter the audit log">
      <span className="text-[13px] text-muted-foreground">Filter:</span>
      <div className={chip}>
        <label htmlFor="audit-area" className="text-muted-foreground">
          Area
        </label>
        <select id="audit-area" name="area" defaultValue={current.area ?? ""} className={control}>
          <option value="">Everything</option>
          {areas.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className={chip}>
        <label htmlFor="audit-actor" className="text-muted-foreground">
          Who
        </label>
        <select id="audit-actor" name="actor" defaultValue={current.actor ?? ""} className={control}>
          <option value="">Anyone</option>
          {actors.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className={chip}>
        <label htmlFor="audit-result" className="text-muted-foreground">
          Result
        </label>
        <select id="audit-result" name="result" defaultValue={current.result ?? ""} className={control}>
          <option value="">Any result</option>
          <option value="success">Success</option>
          <option value="denied">Denied</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <div className={chip}>
        <label htmlFor="audit-from" className="text-muted-foreground">
          From (UTC)
        </label>
        <input
          type="date"
          id="audit-from"
          name="from"
          defaultValue={current.from ?? ""}
          className={`${control} am-num`}
        />
      </div>
      <div className={chip}>
        <label htmlFor="audit-to" className="text-muted-foreground">
          To (UTC)
        </label>
        <input type="date" id="audit-to" name="to" defaultValue={current.to ?? ""} className={`${control} am-num`} />
      </div>
      <button
        type="submit"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-3 text-[13px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Filter className="size-3.5" aria-hidden />
        Apply filters
      </button>
      {active && (
        <a
          href={action}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
          Clear filters
        </a>
      )}
    </form>
  );
}
