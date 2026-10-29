// SPDX-License-Identifier: AGPL-3.0-only
import { listExports, requestExport } from "@anhourmail/core/data";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** The account exports the caller asked for (`account.export`, Owners): status and dates, never the archive. */
export const GET = route(async ({ req }, params) =>
  ok(
    await listExports(container().deps, await getActor(req.headers), {
      kind: "account",
      accountId: str(params.accountId),
    }),
  ),
);

/**
 * Ask for an export of the account's control-plane data and audit log (`account.export`; ADR-0025). The worker builds
 * it and emails the caller; 202 with the queued export. One at a time (409). `export` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) =>
    ok(
      await requestExport(
        container().deps,
        await getActor(req.headers),
        { kind: "account", accountId: str(params.accountId) },
        meta,
      ),
      202,
    ),
  { limit: "export" },
);
