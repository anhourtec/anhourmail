// SPDX-License-Identifier: AGPL-3.0-only
import { restoreMailbox } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Restore a mailbox during its deletion grace period (`mailbox.manage`); the worker turns it back on. */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await restoreMailbox(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      meta,
    ),
  ),
);
