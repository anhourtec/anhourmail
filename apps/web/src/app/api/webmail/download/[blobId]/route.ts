// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { log } from "@anhourmail/server/log";

import { route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId } from "@/server/webmail/view";

/**
 * Attachment download (`/api/webmail/download/:blobId`, no name in the URL), streamed from Stalwart without buffering. Always `Content-Disposition: attachment` with a
 * generic content type, `nosniff` and a sandboxing CSP, so nothing a sender attaches is ever rendered on this
 * origin (docs/internal/05-webmail.md "Rendering safety").
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const blobId = typeof params.blobId === "string" ? params.blobId : "";
    if (!isJmapId(blobId)) return notFound();
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      const upstream = await webmail().download(id, s.accountId, blobId, "attachment", "read");
      if (upstream.status === 404) {
        await upstream.body?.cancel();
        return notFound();
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        log.warn("webmail download failed", { component: "webmail", status: upstream.status });
        return NextResponse.json(
          { error: { code: "unavailable", message: "That attachment couldn't be downloaded." } },
          { status: 502 },
        );
      }
      const headers = new Headers({
        "Content-Type": "application/octet-stream",
        // No filename here: the link's `download` attribute names the file (the same sanitised name the reader
        // shows), so attachment names never travel in a URL or reach an access log.
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      const length = upstream.headers.get("content-length");
      if (length) headers.set("Content-Length", length);
      return new Response(upstream.body, { status: 200, headers });
    });
  },
  { session: "webmail", limit: "webmailDownload", delegated: "full_access" },
);
