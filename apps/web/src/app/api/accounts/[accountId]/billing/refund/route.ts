// SPDX-License-Identifier: AGPL-3.0-only
import { refundSubscription } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * The 14-day self-service refund: the first or a renewal payment, refunded in full, and the subscription ends now (`billing.manage` ★; ADR-0029 §9). Needs a fresh password step-up (403 `step_up_required`); refused while acting
 * as someone. Tier `sensitive` (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    return ok(
      await refundSubscription(
        container().deps,
        billingContext(),
        actor,
        paramOf(params.accountId),
        { sessionId },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);
