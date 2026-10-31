// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { SenderNameChange } from "@/server/webmail/settings";

/**
 * The mailbox's sender name (rule 61, `people/names.ts`): `{ name }` changes its person's name, the one source, when
 * the mailbox follows it; 403 when an admin set the mailbox's name or the person is in another account too.
 */
export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = SenderNameChange.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Use a name up to 80 characters.");
    return handleWebmail(async () => ok(await webmailSettings().updateSenderName(id, account, parsed.data, meta)));
  },
  { session: "webmail", limit: "write" },
);
