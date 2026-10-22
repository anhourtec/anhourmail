// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { htmlToText, sanitizeMessageHtml } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * A forwarded or attached message (a message/rfc822 attachment of `emailId`), read with `Email/parse` and
 * sanitised like any other. The blob must be that message's attachment; anything else → 404.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    const blobId = typeof params.blobId === "string" ? params.blobId : "";
    if (!isJmapId(emailId) || !isJmapId(blobId)) return notFound();
    return handleWebmail(async () => {
      const view = await webmail().attachedMessage(id, emailId, blobId, sanitizeMessageHtml, htmlToText);
      return view ? ok(view) : notFound();
    });
  },
  { session: "webmail", limit: "webmail" },
);
