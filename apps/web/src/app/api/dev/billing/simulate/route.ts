// SPDX-License-Identifier: AGPL-3.0-only
import { ValidationError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { requireDevBilling, SimulateBody, simulate } from "@/server/dev-billing";
import { ok, readJson, route } from "@/server/http/route";

export const dynamic = "force-dynamic";

/**
 * Dev only (ADR-0029 §3): one action on the fake billing provider (pay or decline a checkout, a failing card,
 * advancing the fake clock, retries running out, cancelling, refunds, disputes), then its signed events delivered
 * through the real webhook route. 404 unless billing is the fake and this isn't a production process (and production
 * builds never route `/api/dev/` at all: `proxy.ts`). The caller must hold `billing.manage` on the fake object's
 * account (404 / 403 otherwise).
 */
export const POST = route(async ({ req }) => {
  requireDevBilling();
  const parsed = SimulateBody.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Unknown action.");
  const actor = await getActor(req.headers);
  return ok(await simulate(actor, parsed.data));
});
