// SPDX-License-Identifier: AGPL-3.0-only
import { listExports, requestExport } from "@anhourmail/core/data";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/** The caller's own personal data exports (`self.data.export`); refused while acting as someone. */
export const GET = route(async ({ req }) =>
  ok(await listExports(container().deps, await getActor(req.headers), { kind: "personal" })),
);

/**
 * Ask for an export of one's own data (`self.data.export`; ADR-0025): profile, memberships, own mailboxes' settings,
 * sign-in security and activity. 202 with the queued export; one at a time (409); never while acting as someone (403).
 * `export` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }) =>
    ok(await requestExport(container().deps, await getActor(req.headers), { kind: "personal" }, meta), 202),
  { limit: "export" },
);
