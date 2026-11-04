// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { setAddressCeilingOverride } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the number (a whole number in range, or null for the configured ceiling). */
const Body = z.object({ ceiling: z.union([z.number(), z.null()]).optional() });

/**
 * Staff: set or reset an account's address ceiling override (`platform.billing.manage` ★; ADR-0029 §7): `{ ceiling }`
 * (a whole number, or null for the configured ceiling). Fresh step-up (403 `step_up_required`), refused while acting as
 * someone; unknown accounts 404. Tier `sensitive` (fail closed).
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    const out = await setAddressCeilingOverride(
      container().deps,
      actor,
      str(params.accountId),
      { ceiling: parsed.success ? parsed.data.ceiling : "invalid" },
      { sessionId },
      meta,
    );
    return ok(out);
  },
  { limit: "sensitive" },
);
