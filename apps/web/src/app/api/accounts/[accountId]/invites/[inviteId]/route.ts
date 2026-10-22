// SPDX-License-Identifier: AGPL-3.0-only
import { revokeInvite } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Revoke a pending invite: its link stops working at once (`member.manage`). */
export const DELETE = route(async ({ req, meta }, params) =>
  ok(
    await revokeInvite(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.inviteId),
      meta,
    ),
  ),
);
