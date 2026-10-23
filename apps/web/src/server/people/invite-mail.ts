// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { SentInvite } from "@anhourmail/core/people";
import { INVITE_TTL_DAYS } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { log } from "@anhourmail/server/log";

import { container } from "../container";
import { env } from "../env";
import { inviteEmail } from "../mail/system-email";
import { platform } from "../platform";

/**
 * Emails an invite link after the invite is stored. A delivery failure doesn't undo the invite (it can be resent);
 * the caller is told so it can say so. The token is only ever in this email, never in a response or a log line.
 */
export async function sendInviteEmail(sent: SentInvite, inviter: { name?: string; email: string }): Promise<boolean> {
  try {
    await container().mailer.send(
      inviteEmail({
        to: sent.invite.email,
        accountName: sent.accountName,
        inviter: inviter.name && inviter.name.trim() !== "" ? inviter.name.trim() : inviter.email,
        role: ROLE_LABELS[`account:${sent.invite.role}`],
        url: `${env().APP_URL.replace(/\/$/, "")}/invite/${sent.token}`,
        days: INVITE_TTL_DAYS,
        site: platform().hosts.site,
      }),
    );
    return true;
  } catch (err) {
    log.error("invite email failed", { component: "people", inviteId: sent.invite.id, err });
    return false;
  }
}
