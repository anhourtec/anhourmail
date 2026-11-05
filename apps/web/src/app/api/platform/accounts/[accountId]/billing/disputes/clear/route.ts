// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { clearDisputes } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { billingContext, paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readOptionalJson, route } from "@/server/http/route";

/** Shape only; the service checks the list against the account's open and lost disputes. */
const Body = z.object({ disputeIds: z.array(z.string().max(255)).max(100).optional() });

/**
 * Staff: clear the disputes that keep the account's sending paused, including a lost one (`platform.billing.manage`
 * ★; ADR-0029 §5, §9): `{ disputeIds }`, the ones the page showed; 409 `changed` when the open or lost set differs
 * now. Cleared disputes never restrict again; the account's state follows on its sync. Fresh step-up; refused while
 * acting as someone; 409 `not_disputed` when nothing is disputed; 503 while billing is off; unknown accounts 404. Audited `billing.dispute_closed` (outcome `cleared`) in the account's log (rule 49). Tier
 * `sensitive`.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readOptionalJson(req)) ?? {});
    return ok(
      await clearDisputes(
        container().deps,
        billingContext(),
        actor,
        paramOf(params.accountId),
        { disputeIds: parsed.success ? parsed.data.disputeIds : undefined },
        { sessionId },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);
