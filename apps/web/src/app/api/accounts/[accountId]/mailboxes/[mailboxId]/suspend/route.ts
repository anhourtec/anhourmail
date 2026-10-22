// SPDX-License-Identifier: AGPL-3.0-only
import { suspendMailbox } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Suspend (`mailbox.manage`): no sign-in and mail refused, nothing deleted; the worker applies it. */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await suspendMailbox(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      meta,
    ),
  ),
);
