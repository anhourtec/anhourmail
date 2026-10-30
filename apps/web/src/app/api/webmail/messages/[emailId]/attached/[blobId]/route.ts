// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { env } from "@/server/env";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { linkingSanitizer, withSenderKey } from "@/server/webmail/image-proxy";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { htmlToText } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * A forwarded or attached message (a message/rfc822 attachment of `emailId`), read with `Email/parse` and
 * sanitised like any other (remote images blocked, with image links for this session). The blob must be that
 * message's attachment; anything else → 404.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    const blobId = typeof params.blobId === "string" ? params.blobId : "";
    if (!isJmapId(emailId) || !isJmapId(blobId)) return notFound();
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      const secret = env().BETTER_AUTH_SECRET;
      const sanitize = linkingSanitizer(secret, { sessionId: id, accountId: s.accountId });
      const view = await webmail().attachedMessage(id, emailId, blobId, sanitize, htmlToText);
      return view ? ok(withSenderKey(view, secret, s.username, undefined)) : notFound();
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
