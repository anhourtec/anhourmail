// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { JunkInput } from "@/server/webmail/sieve";

/** Saves blocked and safe senders and "trusted senders only" (managed Sieve script; `junk_rules.changed`). */
export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = JunkInput.safeParse(await readJson(req));
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Use addresses or domains, up to 300 of each.");
    }
    return handleWebmail(async () => ok(await webmailSettings().saveJunk(id, account, parsed.data, meta)));
  },
  { session: "webmail", limit: "write" },
);
