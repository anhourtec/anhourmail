// SPDX-License-Identifier: AGPL-3.0-only
import { searchAccounts } from "@anhourmail/core/platform";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/** Staff: search customer accounts by name, id or member email (`platform.accounts.read`). Metadata only. */
export const GET = route(async ({ req }) => {
  const q = new URL(req.url).searchParams;
  return ok(
    await searchAccounts(container().deps, await getActor(req.headers), { query: q.get("q"), page: q.get("page") }),
  );
});
