// SPDX-License-Identifier: AGPL-3.0-only
import { parseAuditFilters, platformAuditPage } from "@anhourmail/core/audit";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/** Platform audit log: Global Admin and Reports Reader. Same filters as the account log. */
export const GET = route(async ({ req }) => {
  const filters = parseAuditFilters(Object.fromEntries(new URL(req.url).searchParams));
  return ok(await platformAuditPage(container().deps, await getActor(req.headers), filters));
});
