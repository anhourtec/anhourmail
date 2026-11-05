// SPDX-License-Identifier: AGPL-3.0-only
import { revokeInviteCode } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Staff: revoke an unused invite code (ADR-0029 §8). The permission follows the code's kind, as at creation; unknown →
 * 404, already used or revoked → 409. Tier `sensitive`.
 */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    return ok(await revokeInviteCode(container().deps, actor, paramOf(params.codeId), meta));
  },
  { limit: "sensitive" },
);
