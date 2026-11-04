// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { startCheckout } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service checks the plan, currency, amounts and quantities against the public facts. */
const Body = z.object({
  plan: z.string().max(20),
  currency: z.string().max(3),
  supporterAmountMinor: z.number().optional(),
  storageBlocks: z.number().optional(),
  extraMailboxes: z.number().optional(),
});

/**
 * Starts a checkout (`billing.manage` ★; ADR-0029 §9): `{ plan, currency, supporterAmountMinor?, storageBlocks?,
 * extraMailboxes? }` → `{ url }`, the provider's checkout page (the console navigates there). Tier `billingProvider`
 * (fail closed: each call is a provider request and checkout is a card-testing surface).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    const out = await startCheckout(
      container().deps,
      billingContext(),
      actor,
      paramOf(params.accountId),
      parsed.success ? parsed.data : {},
      meta,
    );
    return ok(out);
  },
  { limit: "billingProvider" },
);
