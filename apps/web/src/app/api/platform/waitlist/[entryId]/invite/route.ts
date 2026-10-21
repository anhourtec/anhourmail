// SPDX-License-Identifier: AGPL-3.0-only
import { inviteFromWaitlist } from "@anhourmail/core/invite";
import { log } from "@anhourmail/server/log";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { ok, route } from "@/server/http/route";
import { inviteEmail } from "@/server/mail/system-email";

/**
 * Invite a confirmed waitlist sign-up (`waitlist.manage`). The token goes only into the email — never into the
 * response or logs. 404 unknown entry, 409 not confirmed or already invited.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const entryId = typeof params.entryId === "string" ? params.entryId : "";
    const { email, token, expiresAt } = await inviteFromWaitlist(
      container().deps,
      await getActor(req.headers),
      entryId,
      meta,
    );
    const url = `${env().APP_URL.replace(/\/$/, "")}/sign-up?invite=${encodeURIComponent(token)}`;
    let emailed = true;
    await container()
      .mailer.send(inviteEmail({ to: email, url }))
      .catch((err: unknown) => {
        emailed = false;
        log.error("invite email failed", { component: "invites", err });
      });
    return ok({ invited: true, emailed, expiresAt: expiresAt.toISOString() }, 201);
  },
  { limit: "invite" },
);
