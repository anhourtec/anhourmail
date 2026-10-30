// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId, isPreviewableImage } from "@/server/webmail/view";

/**
 * Inline preview of an image attachment (thumbnails and the image viewer, shown with `<img>`). Only raster image
 * types are served, with that type, `nosniff` and a sandboxing CSP — never SVG, HTML or anything else, which only
 * ever download (`/api/webmail/download/:blobId`).
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const blobId = typeof params.blobId === "string" ? params.blobId : "";
    const type = (new URL(req.url).searchParams.get("type") ?? "").toLowerCase();
    if (!isJmapId(blobId)) return notFound();
    if (!isPreviewableImage(type)) {
      return NextResponse.json(
        { error: { code: "bad_request", message: "Only images can be previewed." } },
        { status: 400 },
      );
    }
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      const upstream = await webmail().download(id, s.accountId, blobId, "preview", "read");
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return notFound();
      }
      const headers = new Headers({
        "Content-Type": type,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "private, max-age=300",
      });
      const length = upstream.headers.get("content-length");
      if (length) headers.set("Content-Length", length);
      return new Response(upstream.body, { status: 200, headers });
    });
  },
  { session: "webmail", limit: "webmailDownload", delegated: "full_access" },
);
