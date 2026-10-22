// SPDX-License-Identifier: AGPL-3.0-only
import { accountAuditPage, parseAuditFilters } from "@anhourmail/core/audit";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Account audit log: Owner, User Admin, Auditor. Other accounts' ids return 404. Filters: `area`, `actor` (a person's
 * id, or staff / user / system / anonymous), `result`, `from` / `to` (YYYY-MM-DD, UTC), `before` (paging), `limit`.
 */
export const GET = route(async ({ req }, params) => {
  const accountId = typeof params.accountId === "string" ? params.accountId : "";
  const filters = parseAuditFilters(Object.fromEntries(new URL(req.url).searchParams));
  return ok(await accountAuditPage(container().deps, await getActor(req.headers), accountId, filters));
});
