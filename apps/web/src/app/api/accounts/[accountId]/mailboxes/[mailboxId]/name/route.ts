// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { renameMailbox } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const Body = z.object({ displayName: z.string().max(400).optional() });

/** "Edit name" (`mailbox.manage`): `{ displayName }`, empty to clear. Other accounts' ids return 404. */
export const PUT = route(async ({ req, meta }, params) => {
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  return ok(
    await renameMailbox(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      { displayName: parsed.success ? parsed.data.displayName : undefined },
      meta,
    ),
  );
});
