// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * The From picker (ADR-0026 §6): `{ identities, shared }` — the active mailbox's own identities, then every mailbox
 * shared with its person that they may send from (`mode` `send_as` or `send_on_behalf`, send as winning when both are
 * held, with its label). Nothing is minted; each send checks the right again. The person's own mailbox only (403 while
 * a shared one is active).
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmail().senders(id)));
  },
  { session: "webmail", limit: "webmail" },
);
