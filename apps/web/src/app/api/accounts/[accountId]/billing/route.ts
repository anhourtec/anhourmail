// SPDX-License-Identifier: AGPL-3.0-only
import { billingOverview } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * The account's billing overview (`billing.read`; ADR-0029 §9): plan, state, renewal, add-ons in force, usage against
 * the ceilings, holds after a lapse and whether a refund may still be possible. Our own row only: no provider call.
 */
export const GET = route(async ({ req }, params) => {
  const actor = await getActor(req.headers);
  return ok(await billingOverview(container().deps, billingContext(), actor, paramOf(params.accountId)));
});
