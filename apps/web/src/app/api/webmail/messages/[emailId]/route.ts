// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { env, senderDelegationKey } from "@/server/env";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { platform } from "@/server/platform";
import { linkingSanitizer, withSenderKey } from "@/server/webmail/image-proxy";
import { type AuthSummary, authResults, isInternalMail, trustedAuthservIds } from "@/server/webmail/original";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { htmlToText } from "@/server/webmail/sanitize";
import { isJmapId } from "@/server/webmail/view";

/**
 * One message for the reader: headers, attachments, and the HTML body sanitised on the server (remote images
 * blocked, each with a signed image link for "Load images", bound to this session and mailbox) for the sandboxed
 * frame, or the plain-text / markdown body as safe structures, plus calendar events. `?full=1` lifts the body cap
 * ("View entire message"). Unknown ids → 404.
 */
/** The internal-mail marker check, false when the key isn't usable (never thrown into the response). */
function internalMarkerValid(
  headers: Parameters<typeof isInternalMail>[0],
  from: string,
  trusted: readonly string[],
): boolean {
  try {
    return isInternalMail(headers, from, senderDelegationKey(), trusted);
  } catch {
    return false;
  }
}

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
      // Only a verified From may load images without asking: read our own Authentication-Results, or our server's
      // internal-mail marker (mail submitted here, which has no results of ours), when it matters.
      let auth: AuthSummary | null | undefined;
      let internal = false;
      const from = view.from[0]?.email;
      if (view.loadableImages > 0) {
        const e = env();
        const headers = await webmail()
          .headers(id, emailId)
          .catch(() => undefined);
        if (headers) {
          const trusted = trustedAuthservIds(e.MAIL_AUTHSERV_ID, platform().hosts.mx, e.NODE_ENV === "production");
          auth = authResults(headers, trusted);
          internal = from !== undefined && internalMarkerValid(headers, from, trusted);
        }
      }
      return ok(withSenderKey(view, secret, s.username, auth, internal));
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
