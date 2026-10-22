// SPDX-License-Identifier: AGPL-3.0-only
import { createAlias, listAliases } from "@anhourmail/core/aliases";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Aliases the caller can manage, where new ones can point, and the plan's limits (`alias.manage.own`). */
export const GET = route(async ({ req }, params) =>
  ok(await listAliases(container().deps, await getActor(req.headers), str(params.accountId))),
);

/** Add an alias (`{ mailboxId, localPart, domainId }`) or a masked alias (`{ kind: "masked", mailboxId }`). */
export const POST = route(
  async ({ req, meta }, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const alias = await createAlias(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      {
        kind: body.kind,
        mailboxId: body.mailboxId,
        localPart: body.localPart,
        domainId: body.domainId,
        description: body.description,
      },
      meta,
    );
    return ok(alias, 201);
  },
  { limit: "aliasCreate" },
);
