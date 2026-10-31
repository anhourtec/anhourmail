// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { env } from "@/server/env";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { linkingSanitizer, withImageSender } from "@/server/webmail/image-proxy";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { safeSenders } from "@/server/webmail/safe-senders";
import { htmlToText } from "@/server/webmail/sanitize";
import { senderEvidence } from "@/server/webmail/sender-check";
import { isJmapId } from "@/server/webmail/view";

/**
 * One message for the reader: headers, attachments, and the HTML body sanitised on the server (remote images
 * blocked, each with a signed image link for "Load images", bound to this session and mailbox) for the sandboxed
 * frame, or the plain-text / markdown body as safe structures, plus calendar events. `?full=1` lifts the body cap
 * ("View entire message"). Unknown ids → 404.
 *
 * With images to load and a verified From, the view also says whether that From is on the open mailbox's Safe
 * senders (ADR-0027 §3): the session's active mailbox, or in a tab of a mailbox shared with the person the mailbox the
 * delegation gate admitted (the pinned entry is the active one here) — never an id the browser sent.
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
      // Only a verified From may load images without asking: read our own Authentication-Results, or our server's
      // internal-mail marker (mail submitted here, which has no results of ours), when it matters.
      let evidence: ReturnType<typeof senderEvidence> = { auth: undefined, internal: false };
      if (view.loadableImages > 0) {
        const headers = await webmail()
          .headers(id, emailId)
          .catch(() => undefined);
        evidence = senderEvidence(headers, view.from[0]?.email);
      }
      return ok(
        await withImageSender(view, secret, s.username, evidence.auth, evidence.internal, (from) =>
          safeSenders().match(s.accountId, s.username, from),
        ),
      );
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
