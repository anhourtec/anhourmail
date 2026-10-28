// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { z } from "zod";

import { changeOwnMailboxPassword, passwordJobState } from "@anhourmail/core/mailboxes";
import { failuresExceeded, LIMITS, recordFailure } from "@anhourmail/server/rate-limit";
import { MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendMailboxPasswordResetNotice } from "@/server/mail/mailbox-password-email";
import { badRequest, handleWebmail, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailCookie, webmailFailures, webmailSessionId } from "@/server/webmail/instance";
import { changeWebmailPassword } from "@/server/webmail/password";

const Change = z.object({
  current: z.string().min(1).max(1024),
  next: z
    .string()
    .min(1)
    .max(MAILBOX_PASSWORD.max * 4),
});

/** The same per-address subject as the webmail sign-in: a wrong current password is a password guess. */
const subject = (address: string) =>
  `a:${createHash("sha256").update(address.trim().toLowerCase()).digest("base64url").slice(0, 22)}`;

/**
 * Change the session's own mailbox password: `{ current, next }`. The current password is checked with the mail server
 * first (wrong ones count towards the sign-in's per-address limit); the new one is hashed and applied by the worker;
 * this session stays signed in, every other webmail session of the mailbox ends. Neither password is stored or logged.
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = Change.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Enter your current password and a new one.");
    const deps = container().deps;
    return handleWebmail(async () => {
      const out = await changeWebmailPassword(
        {
          mail: webmail(),
          change: (address, password, m) =>
            changeOwnMailboxPassword(deps, container().passwords, address, { password }, m),
          state: (jobId) => passwordJobState(deps, jobId),
          notify: (to, address) => sendMailboxPasswordResetNotice(to, { address, by: "webmail", at: deps.clock.now() }),
          failures: {
            exceeded: (address) =>
              failuresExceeded(
                webmailFailures(),
                "webmailSignInAddress",
                LIMITS.webmailSignInAddress,
                subject(address),
              ),
            record: (address) =>
              recordFailure(webmailFailures(), "webmailSignInAddress", LIMITS.webmailSignInAddress, subject(address)),
          },
        },
        id,
        { current: parsed.data.current, next: parsed.data.next, account: shownAccount(req) },
        meta,
      );
      // The session moved to a new id with the fresh tokens: the cookie follows; the id never goes in the body.
      const { sessionId: renewed, ...body } = out;
      const res = ok(body);
      if (renewed) res.headers.append("Set-Cookie", webmailCookie(renewed, webmail().store.cookieMaxAgeSec));
      return res;
    });
  },
  { session: "webmail", limit: "mailboxPassword", passwordChange: "allowed" },
);
