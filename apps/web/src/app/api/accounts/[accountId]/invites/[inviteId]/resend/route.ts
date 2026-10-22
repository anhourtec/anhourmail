// SPDX-License-Identifier: AGPL-3.0-only
import { resendInvite } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { sendInviteEmail } from "@/server/people/invite-mail";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Send a pending invite again with a new link and a fresh period; the old link stops working (`member.manage`). */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    const sent = await resendInvite(container().deps, actor, str(params.accountId), str(params.inviteId), meta);
    const emailSent = actor.kind === "user" ? await sendInviteEmail(sent, actor) : false;
    return ok({ invite: sent.invite, emailSent });
  },
  { limit: "invite" },
);
