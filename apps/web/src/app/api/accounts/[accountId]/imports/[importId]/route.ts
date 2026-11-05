// SPDX-License-Identifier: AGPL-3.0-only
import { getImport } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { importContext } from "@/server/imports";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** One import's progress, with its folders by role (and by name while it runs). Someone else's is a 404. */
export const GET = route(async ({ req }, params) =>
  ok(
    await getImport(
      container().deps,
      importContext().sealer,
      await getActor(req.headers),
      str(params.accountId),
      str(params.importId),
    ),
  ),
);
