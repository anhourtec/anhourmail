// SPDX-License-Identifier: AGPL-3.0-only
import { listAccountAudit } from "@anhourmail/core/audit";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/** Account audit log: Owner, User Admin, Auditor. Other accounts' ids return 404. */
export const GET = route(async ({ req }, params) => {
  const accountId = typeof params.accountId === "string" ? params.accountId : "";
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  return ok(await listAccountAudit(container().deps, await getActor(req.headers), accountId, { limit }));
});
