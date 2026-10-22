// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Move = z.object({
  ids: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/))
    .min(1)
    .max(500),
  to: z.enum(["mine", "other"]),
});

/** Moves contacts to My contacts or Other contacts. */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Move.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose contacts and where to move them.");
    return handleWebmail(async () =>
      ok({ moved: await webmail().moveContacts(id, account, parsed.data.ids, parsed.data.to) }),
    );
  },
  { session: "webmail", limit: "write" },
);
