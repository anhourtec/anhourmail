// SPDX-License-Identifier: AGPL-3.0-only
import { confirmWaitlist } from "@anhourmail/core/waitlist";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Confirm a waitlist address from the emailed link: 200 confirmed, or 400 invalid_token (unknown/used/expired). */
export const POST = route(
  async ({ req, meta }) => {
    const body = (await readJson(req)) as { token?: unknown } | null;
    const result = await confirmWaitlist(container().deps, await getActor(req.headers), body?.token, meta);
    return ok(result);
  },
  { limit: "publicForm", origin: "public" },
);
