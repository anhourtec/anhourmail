// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";

/**
 * Everything the settings window shows for the active mailbox: preferences (control plane), identities with their
 * signatures, storage, the automatic-reply / forwarding / junk rules (mail server) and the forwarding confirmation.
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmailSettings().overview(id)));
  },
  { session: "webmail", limit: "webmailSettings" },
);
