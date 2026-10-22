// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { AUDIT_AREAS, AREA_LABELS, type AuditFilters, parseAuditFilters } from "@anhourmail/core/audit";

/** Search params → validated filters, plus the raw values to refill the form and keep in paging links. */
export function readAuditParams(sp: Record<string, string | string[] | undefined>): {
  filters: AuditFilters;
  current: { area?: string; actor?: string; result?: string; from?: string; to?: string };
  paged: boolean;
} {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const raw = { area: one("area"), actor: one("actor"), result: one("result"), from: one("from"), to: one("to") };
  const filters = parseAuditFilters({ ...raw, before: one("before"), limit: "50" });
  // Only values that survived validation go back into the form and links.
  const current: { area?: string; actor?: string; result?: string; from?: string; to?: string } = {};
  for (const key of ["area", "actor", "result", "from", "to"] as const) {
    const value = raw[key];
    if (filters[key] !== undefined && value !== undefined) current[key] = value;
  }
  return { filters, current, paged: filters.beforeSeq !== undefined };
}

export const AREA_OPTIONS = AUDIT_AREAS.map((a) => ({ value: a, label: AREA_LABELS[a] }));
