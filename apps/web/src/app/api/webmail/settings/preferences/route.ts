// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";

/**
 * Changes display preferences (known keys with allowed values only; `@anhourmail/shared/webmail`), stored per
 * mailbox in the control plane and audited by key name. Returns the full set.
 */
export const PATCH = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const body = await readJson(req);
    return handleWebmail(async () => ok(await webmailSettings().updatePreferences(id, account, body, meta)));
  },
  { session: "webmail", limit: "write" },
);
