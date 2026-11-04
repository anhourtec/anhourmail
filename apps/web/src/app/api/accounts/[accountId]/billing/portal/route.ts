// SPDX-License-Identifier: AGPL-3.0-only
import { openBillingPortal } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Opens the provider's customer portal (`billing.manage` ★; ADR-0029 §9): payment method, billing address, tax ids,
 * invoices and cancelling at period end → `{ url }`. Tier `billingProvider` (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    return ok(await openBillingPortal(container().deps, billingContext(), actor, paramOf(params.accountId), meta));
  },
  { limit: "billingProvider" },
);
