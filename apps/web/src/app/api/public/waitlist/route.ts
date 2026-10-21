// SPDX-License-Identifier: AGPL-3.0-only
import { after } from "next/server";

import { hashEmail, joinWaitlist } from "@anhourmail/core/waitlist";
import { log } from "@anhourmail/server/log";
import { checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { ok, readJson, route } from "@/server/http/route";
import { waitlistConfirmEmail } from "@/server/mail/system-email";

/**
 * Join the waitlist (double opt-in). Same 202 for new, duplicate and bot submissions, so addresses can't be
 * enumerated; the confirmation email goes out after the response is sent, so response time doesn't reveal
 * whether an email was due (timing would otherwise tell a confirmed address from a new one).
 */
export const POST = route(
  async ({ req, meta }) => {
    const body = await readJson(req);
    const { accepted, confirmation } = await joinWaitlist(container().deps, await getActor(req.headers), body, meta);
    // At most 3 confirmation emails per address per day (fail closed), so the form can't be used to flood an inbox
    // from rotating IPs. Over the cap the answer is still 202 and no email is sent.
    const mailAllowed =
      confirmation !== null &&
      (
        await checkRateLimit(
          container().counter,
          "waitlistMail",
          LIMITS.waitlistMail,
          `email:${hashEmail(confirmation.email)}`,
        )
      ).allowed;
    if (confirmation && mailAllowed) {
      const url = `${env().SITE_URL.replace(/\/$/, "")}/waitlist/confirm?token=${encodeURIComponent(confirmation.token)}`;
      after(() =>
        container()
          .mailer.send(waitlistConfirmEmail({ to: confirmation.email, url }))
          .catch((err: unknown) => {
            // The visitor can sign up again to get a new link; never leak delivery state in the response.
            log.error("waitlist confirmation email failed", { component: "waitlist", err });
          }),
      );
    }
    return ok(accepted, 202);
  },
  { limit: "publicForm", origin: "public" },
);
