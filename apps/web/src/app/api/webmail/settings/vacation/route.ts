// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { VacationChange } from "@/server/webmail/settings";

/** Saves automatic replies (a rule in the mailbox's managed Sieve script; audited as `vacation.changed`). */
export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = VacationChange.safeParse(await readJson(req));
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Check the dates and the message.");
    }
    return handleWebmail(async () => ok(await webmailSettings().saveVacation(id, account, parsed.data, meta)));
  },
  { session: "webmail", limit: "write" },
);
