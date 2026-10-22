// SPDX-License-Identifier: AGPL-3.0-only
import { listPeople } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** People in the account, pending invites and what the caller may do (`member.read`). Other accounts: 404. */
export const GET = route(async ({ req }, params) =>
  ok(await listPeople(container().deps, await getActor(req.headers), str(params.accountId))),
);
