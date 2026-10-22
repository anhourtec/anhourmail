// SPDX-License-Identifier: AGPL-3.0-only
import { revokeAppPasswords } from "@anhourmail/core/app-passwords";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Revoke one app password (`app_password.manage.own` on one's own mailbox; `mailbox.manage` on others). The worker
 * takes it off the mail server within seconds; it shows as revoking until then.
 */
export const DELETE = route(async ({ req, meta }, params) =>
  ok(
    await revokeAppPasswords(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      str(params.appPasswordId),
      meta,
    ),
  ),
);
