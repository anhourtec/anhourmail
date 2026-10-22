// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { sanitizeMessageHtml } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * One message for the reader: headers, attachments, and the HTML body sanitised on the server (remote images
 * blocked) for the sandboxed frame, or the plain-text body. Unknown ids → 404.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    if (!isJmapId(emailId)) return notFound();
    return handleWebmail(async () => {
      const view = await webmail().message(id, emailId, sanitizeMessageHtml);
      return view ? ok(view) : notFound();
    });
  },
  { session: "webmail", limit: "webmail" },
);
