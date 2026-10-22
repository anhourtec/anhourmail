// SPDX-License-Identifier: AGPL-3.0-only
import { viewAccount } from "@anhourmail/core/platform";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Staff: one account's summary (`platform.accounts.read`). Recorded in that account's audit log; unknown ids 404. */
export const GET = route(async ({ req, meta }, params) =>
  ok(await viewAccount(container().deps, await getActor(req.headers), str(params.accountId), meta)),
);
