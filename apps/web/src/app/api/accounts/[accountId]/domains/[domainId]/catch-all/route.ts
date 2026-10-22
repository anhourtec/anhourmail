// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { setCatchAll } from "@anhourmail/core/domains";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** `{ mailboxId }` turns it on for that mailbox; `{ mailboxId: null }` turns it off. The service checks the id. */
const Body = z.object({ mailboxId: z.string().max(64).nullable().optional() });

/**
 * Set a domain's catch-all (`domain.manage`; paid plans, verified domains, an active mailbox of the account). The
 * worker applies it to the mail server.
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    return ok(
      await setCatchAll(
        container().deps,
        await getActor(req.headers),
        str(params.accountId),
        str(params.domainId),
        { mailboxId: parsed.success ? parsed.data.mailboxId : 0 },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);
