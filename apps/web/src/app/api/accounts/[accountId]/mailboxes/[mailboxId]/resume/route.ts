// SPDX-License-Identifier: AGPL-3.0-only
import { resumeMailbox } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Resume a suspended mailbox (`mailbox.manage`); the worker restores access. */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await resumeMailbox(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      meta,
      container().passwords,
    ),
  ),
);
