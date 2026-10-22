// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Send = z.object({
  draftId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  identityId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
});

/**
 * Sends a saved draft from one of the person's identities (server-checked: the draft's From must be that identity,
 * recipients and size within the mailbox's trust tier). The route's fail-closed `sending` tier limits calls per
 * session; the service charges the tier's hourly and daily quotas (per mailbox and per session, one unit per
 * recipient, fail closed). The message is held for a few seconds so it can be undone (`POST /api/webmail/send/undo`).
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = Send.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose a draft and a sender.");
    // Trust-tier quotas (per mailbox and per session, by recipients) are checked inside send(), against the
    // mailbox it actually sends from.
    return handleWebmail(async () => ok(await webmail().send(id, parsed.data.draftId, parsed.data.identityId)));
  },
  { session: "webmail", limit: "sending" },
);
