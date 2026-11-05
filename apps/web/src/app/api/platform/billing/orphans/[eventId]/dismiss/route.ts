// SPDX-License-Identifier: AGPL-3.0-only
import { dismissBillingOrphan } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Staff: dismiss a payment provider event no account could be matched to (`platform.billing.manage` ★; ADR-0029 §4,
 * §9). No body. Only orphans (404 otherwise). Fresh step-up; refused while acting as someone. Audited
 * `billing.orphan_dismissed` in the platform log. Tier `sensitive`.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    return ok(await dismissBillingOrphan(container().deps, actor, paramOf(params.eventId), { sessionId }, meta));
  },
  { limit: "sensitive" },
);
