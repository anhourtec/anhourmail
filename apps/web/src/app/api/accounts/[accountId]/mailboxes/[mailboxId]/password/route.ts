// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { resetMailboxPassword } from "@anhourmail/core/mailboxes";
import { MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendMailboxPasswordResetNotice } from "@/server/mail/mailbox-password-email";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the password against the mailbox password rules. */
const Reset = z.object({
  password: z
    .string()
    .max(MAILBOX_PASSWORD.max * 4)
    .optional(),
});

/**
 * Set a new password on a mailbox (`mailbox.password.reset`): `{ password }`. Needs a recent step-up (403
 * `step_up_required` otherwise), refused while acting as someone and, on an Owner's or admin's mailbox, for anyone but
 * an Owner. The worker applies it (202: it takes a moment); the person the mailbox belongs to is emailed a notice.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Reset.safeParse((await readJson(req)) ?? {});
    const accountId = str(params.accountId);
    const out = await resetMailboxPassword(
      container().deps,
      container().passwords,
      actor,
      accountId,
      str(params.mailboxId),
      { password: parsed.success ? parsed.data.password : null },
      { sessionId },
      meta,
    );
    if (out.owner) {
      await sendMailboxPasswordResetNotice(out.owner.email, {
        address: out.address,
        by: actor.kind === "user" && actor.userId === out.owner.userId ? "self" : "admin",
        at: container().deps.clock.now(),
      });
    }
    return ok({ address: out.address, applying: true }, 202);
  },
  { limit: "mailboxPassword" },
);
