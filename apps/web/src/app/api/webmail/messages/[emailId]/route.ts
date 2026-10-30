// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { env } from "@/server/env";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { platform } from "@/server/platform";
import { linkingSanitizer, withSenderKey } from "@/server/webmail/image-proxy";
import { type AuthSummary, authResults, trustedAuthservIds } from "@/server/webmail/original";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { htmlToText } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * One message for the reader: headers, attachments, and the HTML body sanitised on the server (remote images
 * blocked, each with a signed image link for "Load images", bound to this session and mailbox) for the sandboxed
 * frame, or the plain-text / markdown body as safe structures, plus calendar events. `?full=1` lifts the body cap
 * ("View entire message"). Unknown ids → 404.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const emailId = typeof params.emailId === "string" ? params.emailId : "";
    if (!isJmapId(emailId)) return notFound();
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      const secret = env().BETTER_AUTH_SECRET;
      const full = new URL(req.url).searchParams.get("full") === "1";
      const sanitize = linkingSanitizer(secret, { sessionId: id, accountId: s.accountId });
      const view = await webmail().message(id, emailId, sanitize, htmlToText, { full });
      if (!view) return notFound();
      // Only a verified From may load images without asking: read our own Authentication-Results when it matters.
      let auth: AuthSummary | null | undefined;
      if (view.loadableImages > 0) {
        const e = env();
        auth = await webmail()
          .headers(id, emailId)
          .then((h) =>
            authResults(h, trustedAuthservIds(e.MAIL_AUTHSERV_ID, platform().hosts.mx, e.NODE_ENV === "production")),
          )
          .catch(() => undefined);
      }
      return ok(withSenderKey(view, secret, s.username, auth));
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
