// SPDX-License-Identifier: AGPL-3.0-only
import { route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId } from "@/server/webmail/view";

/**
 * "View original": the message's source as plain text (streamed). `?download=1` saves it as `message.eml`.
 * Always text/plain or octet-stream with nosniff and a sandboxing CSP, so it can never render as a page.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    if (!isJmapId(emailId)) return notFound();
    const download = new URL(req.url).searchParams.get("download") === "1";
    return handleWebmail(async () => {
      const upstream = await webmail().raw(id, emailId);
      if (!upstream?.ok || !upstream.body) {
        await upstream?.body?.cancel();
        return notFound();
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": download ? "application/octet-stream" : "text/plain; charset=utf-8",
          "Content-Disposition": download ? 'attachment; filename="message.eml"' : "inline",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    });
  },
  { session: "webmail", limit: "webmailDownload", delegated: "full_access" },
);
