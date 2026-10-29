// SPDX-License-Identifier: AGPL-3.0-only
import type { DataExportView } from "@anhourmail/core/data";

import type { ExportRow } from "./export-panel";

const fmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (d: Date | null) => (d ? `${fmt.format(d)} UTC` : null);

function size(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Export views as the export panel lists them (formatted on the server, so the page renders the same everywhere). */
export function exportRows(list: readonly DataExportView[]): ExportRow[] {
  return list.map((e) => ({
    id: e.id,
    status: e.status,
    requested: when(e.createdAt) ?? "",
    expires: e.status === "ready" ? when(e.expiresAt) : null,
    downloaded: when(e.downloadedAt),
    size: e.status === "ready" ? size(e.sizeBytes) : null,
  }));
}
