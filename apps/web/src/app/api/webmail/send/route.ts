// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { z } from "zod";

import { enforceLimit, ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Send = z.object({
  draftId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  identityId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  /** A mailbox shared with the person to send from (send as or on behalf, ADR-0026 §6); absent: the identity's own. */
  from: z.email().max(254).optional(),
});

/**
 * Sends a saved draft from one of the person's identities (server-checked: the draft's From must be that identity,
 * recipients and size within the mailbox's trust tier). The route's fail-closed `sending` tier limits calls per
 * session; the service charges the tier's hourly and daily quotas (per mailbox and per session, one unit per
 * recipient, fail closed). The message is held for a few seconds so it can be undone (`POST /api/webmail/send/undo`).
 *
 * With `from`, the draft is sent from that mailbox shared with the person (ADR-0026 §6 and §8): the right is checked
 * now and the send audited before it is submitted (`delegation.sent_as` / `delegation.sent_on_behalf`), it is charged
 * to that mailbox's limits, and its copy goes to that mailbox's Sent. Opening the mailbox for it (a mail-server
 * credential, minted once per session) also counts against the fail-closed `webmailDelegatedOpen` tier per own
 * mailbox. No grant, an unknown address or another account's: the same 404.
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // The mailbox this tab shows: refused (400) if another tab switched the session to a different mailbox.
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Send.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose a draft and a sender.");
    const { draftId, identityId, from } = parsed.data;
    // Trust-tier quotas (per mailbox and per session, by recipients) are checked inside send(), against the
    // mailbox it actually sends from.
    return handleWebmail(async () => {
      if (from === undefined) return ok(await webmail().send(id, draftId, identityId, account));
      const beforeOpen = async () => {
        const s = await webmail().store.read(id);
        const own = (s?.delegated?.via ?? s?.username ?? "").toLowerCase();
        await enforceLimit(
          "webmailDelegatedOpen",
          `mailbox:${createHash("sha256").update(`delegated-open\0${own}`).digest("base64url").slice(0, 22)}`,
        );
      };
      return ok(await webmail().send(id, draftId, identityId, account, { from, req: meta, beforeOpen }));
    });
  },
  { session: "webmail", limit: "sending" },
);
