// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Undo = z.object({
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  /** The mailbox shared with the person it was sent from (`from` of the send), if any. */
  mailbox: z.email().max(254).optional(),
});

/**
 * Cancels a just-sent message while it is still held, and puts it back in Drafts. A send from a mailbox shared with
 * the person names it (`mailbox`): the copy in that mailbox's Sent is removed, the person's own draft is handed back,
 * and the undo is audited (`delegation.send_cancelled`).
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // The mailbox this tab shows: refused (400) if another tab switched the session to a different mailbox.
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Undo.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Nothing to undo.");
    const { submissionId, mailbox } = parsed.data;
    return handleWebmail(async () =>
      ok(
        await webmail().undoSend(id, submissionId, account, mailbox === undefined ? undefined : { mailbox, req: meta }),
      ),
    );
  },
  { session: "webmail", limit: "write" },
);
