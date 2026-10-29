// SPDX-License-Identifier: AGPL-3.0-only
import { recordMailExport } from "@anhourmail/core/data";

import { container } from "@/server/container";
import { crossSiteRefused, fromAnotherSite } from "@/server/http/download";
import { route } from "@/server/http/route";
import { mailExportStream } from "@/server/webmail/export";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId } from "@/server/webmail/view";

/**
 * Export the signed-in mailbox's mail and contacts (ADR-0025): a ZIP of one `.mbox` per folder plus `contacts.vcf`,
 * streamed straight from the mail server with the session's own token; `?folder=<id>` exports one folder. Never stored
 * or logged by us. Audited `data.mail_exported` (counts only) when it ends. `export` tier per webmail session (fail
 * closed); blocked mailboxes (suspended, being deleted, in an account waiting to be deleted) are refused by `route()`.
 */
export const GET = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    if (fromAnotherSite(req)) return crossSiteRefused();
    const folder = new URL(req.url).searchParams.get("folder");
    if (folder !== null && !isJmapId(folder)) {
      return Response.json({ error: { code: "bad_request", message: "Unknown folder." } }, { status: 400 });
    }
    return handleWebmail(async () => {
      const stream = await mailExportStream(webmail(), id, folder === null ? {} : { folderId: folder }, (address, s) =>
        recordMailExport(container().deps, address, { scope: folder === null ? "all" : "folder", ...s }, meta),
      );
      const day = new Date().toISOString().slice(0, 10);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="anhourmail-mail-export-${day}.zip"`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    });
  },
  { session: "webmail", limit: "export" },
);
