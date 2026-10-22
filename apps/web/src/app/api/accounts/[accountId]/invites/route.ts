// SPDX-License-Identifier: AGPL-3.0-only
import { invitePerson } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendInviteEmail } from "@/server/people/invite-mail";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Invite someone by email (`member.manage`; roles other than Member need an Owner). The link goes out by email only:
 * the response carries the invite, never its token.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const actor = await getActor(req.headers);
    const sent = await invitePerson(
      container().deps,
      actor,
      str(params.accountId),
      { email: body.email, role: body.role },
      meta,
    );
    const emailSent = actor.kind === "user" ? await sendInviteEmail(sent, actor) : false;
    return ok({ invite: sent.invite, emailSent }, 201);
  },
  { limit: "invite" },
);
