// SPDX-License-Identifier: AGPL-3.0-only
import { pendingDeletions } from "@anhourmail/core/data";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/** Staff: customer accounts waiting to be deleted, soonest first (`platform.deletions.read`, Global Administrators). */
export const GET = route(async ({ req }) => ok(await pendingDeletions(container().deps, await getActor(req.headers))));
