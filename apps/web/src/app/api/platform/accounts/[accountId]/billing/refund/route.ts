// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { staffRefund } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readOptionalJson, route } from "@/server/http/route";

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
    return ok(
      await staffRefund(
        container().deps,
        billingContext(),
        actor,
        paramOf(params.accountId),
        { endSubscription: parsed.success ? parsed.data.endSubscription : false },
        { sessionId },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);
