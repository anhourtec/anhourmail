// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { changeBilling } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, ChangeBody, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const Body = ChangeBody.extend({ confirmAmountMinor: z.number().optional() });

/**
 * Changes add-on quantities, the plan (Plus ↔ Supporter) or the Supporter amount (`billing.manage` ★; ADR-0029 §7, §9).
 * An increase is charged now only with `confirmAmountMinor` equal to the previewed amount (409 `confirmation_required`
 * otherwise); decreases renew lower and are refused while the account wouldn't fit (409 `addon_in_use`). Tier
 * `billingProvider` (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    return ok(
      await changeBilling(
        container().deps,
        billingContext(),
        actor,
        paramOf(params.accountId),
        parsed.success ? parsed.data : { plan: "invalid" },
        meta,
      ),
    );
  },
  { limit: "billingProvider" },
);
