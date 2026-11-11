// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { staffRefund } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readOptionalJson, route } from "@/server/http/route";
import { scheduleSendingPause } from "@/server/webmail/sending-pause-apply";

const Body = z.object({ endSubscription: z.boolean().optional() });

/**
 * Staff: refund the latest paid invoice in full, outside the self-service rules, and optionally end the subscription
 * now (`platform.billing.manage` ★; ADR-0029 §9): `{ endSubscription? }`. Fresh step-up; refused while acting as
 * someone, while a dispute is open and for an invoice already refunded. Audited `billing.refunded` with `staff: true`
 * in the account's log (rule 49). Tier `sensitive`.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readOptionalJson(req)) ?? {});
    const accountId = paramOf(params.accountId);
    const out = await staffRefund(
      container().deps,
      billingContext(),
      actor,
      accountId,
      { endSubscription: parsed.success ? parsed.data.endSubscription : false },
      { sessionId },
      meta,
    );
    // A refund takes billing's trust tier back: the managed scripts follow (ADR-0034).
    scheduleSendingPause(accountId);
    return ok(out);
  },
  { limit: "sensitive" },
);
