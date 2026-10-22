// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Settings = z.object({ autoSave: z.boolean() });

/** "Automatically save people I email" (kept on the Other contacts address book in Stalwart). */
export const PUT = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Settings.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose on or off.");
    return handleWebmail(async () => {
      await webmail().setAutoSave(id, account, parsed.data.autoSave);
      return ok(parsed.data);
    });
  },
  { session: "webmail", limit: "write" },
);
