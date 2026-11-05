// SPDX-License-Identifier: AGPL-3.0-only
import { pauseImport } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Pause an import: it stops at the next message boundary (no step-up: the safe direction). */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await pauseImport(container().deps, await getActor(req.headers), str(params.accountId), str(params.importId), meta),
  ),
);
