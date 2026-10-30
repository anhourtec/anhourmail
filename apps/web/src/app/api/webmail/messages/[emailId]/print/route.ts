// SPDX-License-Identifier: AGPL-3.0-only
import { route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { PRINT_CSP, printDocument } from "@/server/webmail/print";
import { htmlToText, sanitizeMessageHtml } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * A printable page for one message: escaped headers and the same sanitised body as the reader, served with a
 * sandboxing CSP (opaque origin, no scripts, no remote loads). Opened in a new tab; the person prints it.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    if (!isJmapId(emailId)) return notFound();
    return handleWebmail(async () => {
      const view = await webmail().message(id, emailId, sanitizeMessageHtml, htmlToText);
      if (!view) return notFound();
      return new Response(printDocument(view), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PRINT_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
