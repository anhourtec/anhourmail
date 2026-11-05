// SPDX-License-Identifier: AGPL-3.0-only
import { stopImportSync } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Stop cut-over sync: one last pass copies new mail, then the import completes and is wiped. */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await stopImportSync(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.importId),
      meta,
    ),
  ),
);
