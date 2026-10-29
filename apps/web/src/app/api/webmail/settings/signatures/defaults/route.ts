// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { SignatureDefaultsInput } from "@/server/webmail/settings";

/** Sets the signatures new messages and replies/forwards start with (null = none); the ids must be the mailbox's own. */
export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = SignatureDefaultsInput.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose a signature or (No signature) for each.");
    const defaults = parsed.data;
    return handleWebmail(async () => ok(await webmailSettings().setSignatureDefaults(id, account, defaults, meta)));
  },
  { session: "webmail", limit: "write" },
);
