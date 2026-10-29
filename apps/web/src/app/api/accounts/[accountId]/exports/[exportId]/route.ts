// SPDX-License-Identifier: AGPL-3.0-only
import { downloadExport } from "@anhourmail/core/data";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { exportArchiver } from "@/server/data-lifecycle";
import { route } from "@/server/http/route";
import { archiveResponse, crossSiteRefused, fromAnotherSite } from "@/server/http/download";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Download a ready account export (`account.export`; ADR-0025): only the person who asked (anyone else 404), after a
 * fresh step-up (403 `step_up_required`), until it expires (409). The ZIP is opened from its sealed copy here and
 * streamed as an attachment; audited `data.export_downloaded`. `export` tier (fail closed).
 */
export const GET = route(
  async ({ req, meta }, params) => {
    if (fromAnotherSite(req)) return crossSiteRefused();
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const out = await downloadExport(
      container().deps,
      exportArchiver(),
      actor,
      { kind: "account", accountId: str(params.accountId) },
      str(params.exportId),
      { sessionId },
      meta,
    );
    return archiveResponse(out.bytes, out.filename);
  },
  { limit: "export" },
);
