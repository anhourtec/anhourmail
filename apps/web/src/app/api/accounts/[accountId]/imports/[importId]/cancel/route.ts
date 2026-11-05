// SPDX-License-Identifier: AGPL-3.0-only
import { cancelImport } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Cancel an import at once: its secrets are wiped and its mail-server credential revoked (no step-up). */
export const POST = route(async ({ req, meta }, params) =>
  ok(
    await cancelImport(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.importId),
      meta,
    ),
  ),
);
