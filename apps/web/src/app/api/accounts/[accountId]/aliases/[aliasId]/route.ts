// SPDX-License-Identifier: AGPL-3.0-only
import { deleteAlias, setAliasEnabled } from "@anhourmail/core/aliases";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Turn an alias on or off: `{ enabled }`. */
export const PATCH = route(async ({ req, meta }, params) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  return ok(
    await setAliasEnabled(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.aliasId),
      { enabled: body.enabled },
      meta,
    ),
  );
});

/** Delete an alias; the mail server stops accepting mail for it once the mailbox is synced. */
export const DELETE = route(async ({ req, meta }, params) =>
  ok(
    await deleteAlias(container().deps, await getActor(req.headers), str(params.accountId), str(params.aliasId), meta),
  ),
);
