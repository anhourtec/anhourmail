// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Switch = z.object({ address: z.email().max(254) });

/** Switches the active mailbox to another one already signed in to this session. */
export const PUT = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = Switch.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose a mailbox.");
    return handleWebmail(async () => {
      const s = await webmail().switchMailbox(id, parsed.data.address.trim().toLowerCase());
      return ok({ active: s.username, others: (s.others ?? []).map((m) => m.username) });
    });
  },
  { session: "webmail", limit: "write" },
);
