// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { secondaryButtonClass } from "../ui-classes";

/** Cursor paging over a newest-first log: back to the newest page, or on to older entries. Filters are kept. */
export function AuditPager({
  path,
  filters,
  paged,
  nextBefore,
}: {
  path: string;
  filters: Record<string, string | undefined>;
  /** This page started from a cursor (so there is a newer page). */
  paged: boolean;
  nextBefore: number | null;
}) {
  if (!paged && nextBefore === null) return null;
  const href = (before?: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    if (before !== undefined) q.set("before", String(before));
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  return (
    <nav aria-label="Audit pages" className="flex flex-wrap justify-between gap-3">
      {paged ? (
        <Link href={href()} className={secondaryButtonClass}>
          <ChevronLeft className="size-4" aria-hidden />
          Newest
        </Link>
      ) : (
        <span />
      )}
      {nextBefore !== null && (
        <Link href={href(nextBefore)} className={secondaryButtonClass}>
          Older
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      )}
    </nav>
  );
}
