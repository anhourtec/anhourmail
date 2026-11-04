// SPDX-License-Identifier: AGPL-3.0-only
import { previewBillingChange } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, ChangeBody, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/**
 * What a plan or add-on change costs now (`billing.manage` ★; ADR-0029 §7): `{ amountDueNowMinor, currency, billed }`.
 * Changes nothing. Tier `billingProvider` (fail closed: an increase asks the provider).
 */
export const POST = route(
  async ({ req }, params) => {
    const actor = await getActor(req.headers);
    const parsed = ChangeBody.safeParse((await readJson(req)) ?? {});
    return ok(
      await previewBillingChange(
        container().deps,
        billingContext(),
        actor,
        paramOf(params.accountId),
        parsed.success ? parsed.data : { plan: "invalid" },
      ),
    );
  },
  { limit: "billingProvider" },
);
