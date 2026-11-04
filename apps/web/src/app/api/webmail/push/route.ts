// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailPush, webmailSessionId } from "@/server/webmail/instance";
import { requestPin } from "@/server/webmail/pin";
import { pushStream, isPushAccount } from "@/server/webmail/push-stream";
import { WebmailOwnMailboxOnlyError, type WebmailService } from "@/server/webmail/service";

/** No push for this tab: it keeps polling. */
const noPush = () => new Response(null, { status: 204 });

/**
 * The webmail's push stream (docs/internal/05-webmail.md "Push"): server-sent events telling the browser which data
 * types of its mailbox changed (`state`: type and state names only), when push is up (`ready`) or down (`down`), and
 * when the stream ends for good (`end`). The BFF holds the upstream channel with the mailbox's token
 * (`webmailPush()`); the browser holds only its session cookie.
 *
 * Own mailboxes only. "No push for this tab" is 204 No Content (the event-stream answer for "don't reconnect"): the
 * request pins a mailbox (`x-webmail-shared` / `x-webmail-own` / `?shared=`; the browser never sends one here), the
 * active mailbox is one shared with the person (those tabs poll), or `account` isn't the session's active mailbox's
 * JMAP account (the tab shows another mailbox). Signed out: 401. Over a cap: 503, and the tab polls meanwhile.
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // A stream is the session's active own mailbox only: a request pinning a mailbox (either kind) gets no push.
    if (requestPin(req) !== null) return noPush();
    const account = new URL(req.url).searchParams.get("account") ?? "";
    if (!isPushAccount(account)) {
      return NextResponse.json({ error: { code: "bad_request", message: "Unknown account." } }, { status: 400 });
    }
    return handleWebmail(async () => {
      let target: Awaited<ReturnType<WebmailService["pushTarget"]>>;
      try {
        target = await webmail().pushTarget(id, { connect: true });
      } catch (err) {
        if (err instanceof WebmailOwnMailboxOnlyError) return noPush();
        throw err;
      }
      if (!target) return unauthorized();
      if (target.accountId !== account) return noPush();
      const res = pushStream(webmailPush(), id, target, req.signal);
      if (!res) {
        return NextResponse.json(
          { error: { code: "unavailable", message: "Push isn't available right now." } },
          { status: 503, headers: { "Retry-After": "60" } },
        );
      }
      return res;
    });
  },
  // `cache: "handler"`: the stream's own `no-store, no-transform` (no compression or proxy buffering). `delegated:
  // "allowed"`: a mailbox shared with the person gets the 204 above, from the handler, not a 403.
  { session: "webmail", limit: "webmailPush", cache: "handler", delegated: "allowed" },
);
