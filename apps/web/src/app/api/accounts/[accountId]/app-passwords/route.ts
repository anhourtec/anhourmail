// SPDX-License-Identifier: AGPL-3.0-only
import { listMyAppPasswords } from "@anhourmail/core/app-passwords";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** The caller's own mailboxes in this account with their app passwords (`app_password.manage.own`). No secrets. */
export const GET = route(async ({ req }, params) =>
  ok(await listMyAppPasswords(container().deps, await getActor(req.headers), str(params.accountId))),
);
