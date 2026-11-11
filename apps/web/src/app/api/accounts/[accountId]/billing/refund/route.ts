// SPDX-License-Identifier: AGPL-3.0-only
import { refundSubscription } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { scheduleSendingPause } from "@/server/webmail/sending-pause-apply";

/**
 * The 14-day self-service refund: the first or a renewal payment, refunded in full, and the subscription ends now (`billing.manage` ★; ADR-0029 §9). Needs a fresh password step-up (403 `step_up_required`); refused while acting
 * as someone. A trust tier billing gave goes back to new, and the managed scripts follow. Tier `sensitive` (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = paramOf(params.accountId);
    const out = await refundSubscription(container().deps, billingContext(), actor, accountId, { sessionId }, meta);
    // A refund takes billing's trust tier back: the managed scripts follow (outside forwarding paused, ADR-0034).
    scheduleSendingPause(accountId);
    return ok(out);
  },
  { limit: "sensitive" },
);
