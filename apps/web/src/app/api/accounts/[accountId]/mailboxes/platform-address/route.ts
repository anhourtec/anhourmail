// SPDX-License-Identifier: AGPL-3.0-only
import { checkPlatformAddress } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { enforceLimit, ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Is `?name=` free as a platform-domain address for this account (`mailbox.manage`; other accounts' ids 404)? Only
 * for someone who could claim one (confirmed email, allowance left; else one generic 403). Answers only available /
 * not available, or the naming rule a malformed name breaks — never who holds a name. Limited per client address (the
 * route's tier) and per person (user id, so new sessions don't reset it), both fail closed.
 */
export const GET = route(
  async ({ req }, params) => {
    const actor = await getActor(req.headers);
    if (actor.kind === "user") await enforceLimit("platformAddressCheck", `user:${actor.userId}`);
    const name = new URL(req.url).searchParams.get("name") ?? "";
    return ok(await checkPlatformAddress(container().deps, actor, str(params.accountId), name.slice(0, 64)));
  },
  { limit: "platformAddressCheckIp" },
);
