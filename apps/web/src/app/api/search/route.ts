// SPDX-License-Identifier: AGPL-3.0-only
import { UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { consoleSearch } from "@/server/search";

/**
 * Global search for the console app bar (`?q=`): mailboxes, aliases, domains and people the caller can see, plus
 * customer accounts for staff who can look them up. Every source is read through its service, scoped to the
 * caller's own accounts.
 */
export const GET = route(
  async ({ req }) => {
    const actor = await getActor(req.headers);
    if (actor.kind !== "user") throw new UnauthenticatedError();
    const q = new URL(req.url).searchParams.get("q");
    const names = await container().deps.uow.run((r) =>
      r.access.accountNames(actor.memberships.map((m) => m.accountId)),
    );
    return ok(await consoleSearch(container().deps, actor, q, names));
  },
  { limit: "search" },
);
