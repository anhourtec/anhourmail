// SPDX-License-Identifier: AGPL-3.0-only
import { getDomain, removeDomain } from "@anhourmail/core/domains";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** One domain with the DNS records to publish (`domain.read`). */
export const GET = route(async ({ req }, params) =>
  ok(await getDomain(container().deps, await getActor(req.headers), str(params.accountId), str(params.domainId))),
);

/** Remove a domain no mailbox or alias uses (`domain.manage`). 409 while addresses use it. */
export const DELETE = route(async ({ req, meta }, params) =>
  ok(
    await removeDomain(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.domainId),
      meta,
    ),
  ),
);
