// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { endStaffPlan, grantStaffPlan } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { scheduleSendingPause } from "@/server/webmail/sending-pause-apply";

/** Shape only; the service checks the plan and the number of days. */
const Body = z.object({ plan: z.string().max(20).optional(), days: z.union([z.number(), z.null()]).optional() });

/**
 * Staff: give an account Plus or Supporter without a payment (`platform.billing.manage` ★; ADR-0029 §9): `{ plan, days }`
 * (1–365 days, or null for no end). Not over a live subscription (409). Fresh step-up; refused while acting as someone;
 * unknown accounts 404. Audited in the account's log as staff (rule 49). Tier `sensitive`.
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    const accountId = paramOf(params.accountId);
    const out = await grantStaffPlan(
      container().deps,
      actor,
      accountId,
      parsed.success ? parsed.data : { plan: "invalid" },
      { sessionId },
      meta,
    );
    // A grant never promotes the trust tier (no money, ADR-0034 finding F8), so the managed scripts stay as they are.
    return ok(out);
  },
  { limit: "sensitive" },
);

/** Staff: end a staff grant or a comp now; the account drops to Free, holding what doesn't fit. Same rules. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = paramOf(params.accountId);
    const out = await endStaffPlan(container().deps, actor, accountId, { sessionId }, meta);
    // Ended inside the refund window of an earlier paid promotion, the tier goes back: the scripts follow (ADR-0034).
    scheduleSendingPause(accountId);
    return ok(out);
  },
  { limit: "sensitive" },
);
