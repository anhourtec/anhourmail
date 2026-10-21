// SPDX-License-Identifier: AGPL-3.0-only
import { addDomain, listDomains } from "@anhourmail/core/domains";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const accountOf = (params: Record<string, string | string[] | undefined>) =>
  typeof params.accountId === "string" ? params.accountId : "";

/** The account's domains (`domain.read`). Other accounts' ids return 404. */
export const GET = route(async ({ req }, params) =>
  ok(await listDomains(container().deps, await getActor(req.headers), accountOf(params))),
);

/** Add a domain (`domain.manage`, plans with custom domains). Returns the records to publish. */
export const POST = route(async ({ req, meta }, params) => {
  const body = (await readJson(req)) as { name?: unknown } | null;
  const domain = await addDomain(
    container().deps,
    await getActor(req.headers),
    accountOf(params),
    { name: body?.name },
    meta,
  );
  return ok(domain, 201);
});
