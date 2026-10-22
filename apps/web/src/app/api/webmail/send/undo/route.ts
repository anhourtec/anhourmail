// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Undo = z.object({ submissionId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/) });

/** Cancels a just-sent message while it is still held, and puts it back in Drafts. */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // The mailbox this tab shows: refused (400) if another tab switched the session to a different mailbox.
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Undo.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Nothing to undo.");
    return handleWebmail(async () => ok(await webmail().undoSend(id, parsed.data.submissionId, account)));
  },
  { session: "webmail", limit: "write" },
);
