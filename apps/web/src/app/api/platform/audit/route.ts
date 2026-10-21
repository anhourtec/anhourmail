// SPDX-License-Identifier: AGPL-3.0-only
import { listPlatformAudit } from "@anhourmail/core/audit";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

export const GET = route(async ({ req }) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  return ok(await listPlatformAudit(container().deps, await getActor(req.headers), { limit }));
});
