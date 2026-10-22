// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, notFound, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { IdentityChange } from "@/server/webmail/settings";
import { isJmapId } from "@/server/webmail/view";

/** Changes the sender name and/or signature of one of the mailbox's own addresses (JMAP Identity/set). */
export const PATCH = route(
  async ({ req, meta }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const identityId = typeof params.identityId === "string" ? params.identityId : "";
    if (!isJmapId(identityId)) return notFound();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = IdentityChange.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Use a name up to 100 characters and a signature up to 2,000.");
    return handleWebmail(async () =>
      ok(await webmailSettings().updateIdentity(id, account, identityId, parsed.data, meta)),
    );
  },
  { session: "webmail", limit: "write" },
);
