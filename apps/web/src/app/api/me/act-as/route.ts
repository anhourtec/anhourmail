// SPDX-License-Identifier: AGPL-3.0-only
import { endActAs } from "@anhourmail/core/platform";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * End your open support access now (ADR-0023): the next request is the staff view again. 404 when none is open (it
 * may have just expired). `write` tier, fail open: ending must never be blocked by the limiter's store.
 */
export const DELETE = route(
  async ({ req, meta }) => {
    const out = await endActAs(container().deps, await getActor(req.headers), meta);
    return ok({ ended: true, accountId: out.accountId });
  },
  { limit: "write" },
);
