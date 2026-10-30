// SPDX-License-Identifier: AGPL-3.0-only
import { changeMemberRole, removeMember } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Change someone's role (`account.admins.manage`: Owners). Not your own; never the last Owner (409). */
export const PATCH = route(
  async ({ req, meta }, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    return ok(
      await changeMemberRole(
        container().deps,
        await getActor(req.headers),
        str(params.accountId),
        str(params.userId),
        { role: body.role },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);

/**
 * Remove someone (`member.manage`; an Owner or admin needs an Owner). Their mailboxes stay, person-less, with their
 * sign-in turned off (a new password nobody is shown, app passwords revoked).
 */
export const DELETE = route(
  async ({ req, meta }, params) =>
    ok(
      await removeMember(
        container().deps,
        await getActor(req.headers),
        str(params.accountId),
        str(params.userId),
        meta,
        container().passwords,
      ),
    ),
  { limit: "sensitive" },
);
