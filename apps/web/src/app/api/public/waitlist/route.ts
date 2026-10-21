// SPDX-License-Identifier: AGPL-3.0-only
import { joinWaitlist } from "@anhourmail/core/waitlist";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Join the waitlist. Same 202 for new, duplicate and bot submissions, so addresses can't be enumerated. */
export const POST = route(
  async ({ req, meta }) => {
    const body = await readJson(req);
    const result = await joinWaitlist(container().deps, await getActor(req.headers), body, meta);
    return ok(result, 202);
  },
  { limit: "publicForm", origin: "public" },
);
