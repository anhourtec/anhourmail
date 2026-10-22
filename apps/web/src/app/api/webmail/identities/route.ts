// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/** The addresses the active mailbox may send from (its own address, aliases and masked aliases). */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmail().identities(id)));
  },
  { session: "webmail", limit: "webmail" },
);
