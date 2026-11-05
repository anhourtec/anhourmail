// SPDX-License-Identifier: AGPL-3.0-only
import { getImportBatch, importBatchReport } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * The batch's report as a CSV download (`mailbox, status, messages, duplicates, too_large, failed, error`): counts and
 * codes only, cells that start like a spreadsheet formula prefixed with `'`.
 */
export const GET = route(async ({ req }, params) => {
  const batch = await getImportBatch(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    str(params.batchId),
  );
  return new Response(importBatchReport(batch), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-batch-${batch.createdAt.toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
