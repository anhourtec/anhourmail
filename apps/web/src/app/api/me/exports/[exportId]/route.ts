// SPDX-License-Identifier: AGPL-3.0-only
import { downloadExport } from "@anhourmail/core/data";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { exportArchiver } from "@/server/data-lifecycle";
import { route } from "@/server/http/route";
import { archiveResponse, crossSiteRefused, fromAnotherSite } from "@/server/http/download";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Download one's own ready personal export (`self.data.export`): after a fresh step-up, until it expires; anyone else's
 * id is a 404. Audited `data.export_downloaded`. `export` tier (fail closed).
 */
export const GET = route(
  async ({ req, meta }, params) => {
    if (fromAnotherSite(req)) return crossSiteRefused();
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const out = await downloadExport(
      container().deps,
      exportArchiver(),
      actor,
      { kind: "personal" },
      str(params.exportId),
      { sessionId },
      meta,
    );
    return archiveResponse(out.bytes, out.filename);
  },
  { limit: "export" },
);
