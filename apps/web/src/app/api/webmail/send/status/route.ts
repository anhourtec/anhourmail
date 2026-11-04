// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Status = z.object({
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  /** The mailbox shared with the person it was sent from (`from` of the send), if any. */
  mailbox: z.email().max(254).optional(),
  /** With `mailbox`: the send's `reportTicket` (sealed for this session; names this submission). */
  ticket: z.string().max(2048).optional(),
});

/**
 * After a send's undo hold: which recipients the mail server could not deliver to, with a plain-language reason and
 * the short status code (never the server's reply text). Read with the sending mailbox's own token, so only its own
 * submissions; from a mailbox shared with the person, only the submission the send's sealed `ticket` names (made by
 * this session from it in the last minutes). Anything else is a 404. Waits about 3 s at most while the mail server is
 * still working on it.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // The mailbox the tab shows (the one that sent).
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Status.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose a sent message.");
    const { submissionId, mailbox, ticket } = parsed.data;
    if (mailbox !== undefined && ticket === undefined) return badRequest("Choose a sent message.");
    return handleWebmail(async () => {
      const { undelivered, settled } = await webmail().deliveryReportOf(
        id,
        submissionId,
        account,
        mailbox === undefined ? undefined : { mailbox, ticket: ticket ?? "" },
      );
      return ok({ undelivered, settled });
    });
  },
  { session: "webmail", limit: "write" },
);
