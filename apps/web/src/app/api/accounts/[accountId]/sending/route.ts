// SPDX-License-Identifier: AGPL-3.0-only
import { accountSending } from "@anhourmail/core/trust";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * The account's sending standing for its people (`account.read`, ADR-0034 §5): the tier's label, description and
 * published limits, whether sending outside and from mail apps is open, and the reason in plain words while
 * restricted. Never a staff note, who set it or what promotes it. Another account's id is 404. `read` tier.
 */
export const GET = route(
  async ({ req }, params) => {
    const actor = await getActor(req.headers);
    return ok(await accountSending(container().deps, actor, str(params.accountId)));
  },
  { limit: "read" },
);
