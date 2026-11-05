// SPDX-License-Identifier: AGPL-3.0-only
import { resyncAccountBilling } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Staff: sync the account with the payment provider now (`platform.billing.manage` ★; ADR-0029 §9): queues the
 * account's `billing.sync`, which records whatever it finds. No body. Refused while acting as someone; 503 while billing
 * is off; unknown accounts 404. Audited `billing.resynced` in the account's log (rule 49). Tier `sensitive` (each
 * press costs a provider read).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    return ok(await resyncAccountBilling(container().deps, billingContext(), actor, paramOf(params.accountId), meta));
  },
  { limit: "sensitive" },
);
