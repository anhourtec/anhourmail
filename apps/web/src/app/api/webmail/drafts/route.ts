// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { DraftInput } from "@/server/webmail/compose";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * Saves a draft (autosave and before sending). The BFF builds the message itself: in Drafts, from one of the
 * person's own identities, plain text, capped recipients and attachments (`server/webmail/compose.ts`). A draft
 * being replaced must itself be a draft in Drafts.
 */
export const PUT = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = DraftInput.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Check the addresses, subject and attachments.");
    return handleWebmail(async () => ok(await webmail().saveDraft(id, parsed.data)));
  },
  { session: "webmail", limit: "write" },
);
