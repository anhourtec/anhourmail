// SPDX-License-Identifier: AGPL-3.0-only
import { sendEmailVerification } from "@anhourmail/adapters/auth";
import { UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { auth } from "@/server/auth/instance";
import { ok, route } from "@/server/http/route";

/**
 * Sends the signed-in person a new "confirm your email address" link, to their own sign-in address only (the identity
 * layer's public endpoint isn't exposed, so nobody can make us email someone else). Each call sends an email:
 * `emailVerification` tier, fail closed. The send is audited by the identity hooks (`auth.email_verification_sent`).
 */
export const POST = route(
  async ({ req }) => {
    const actor = await getActor(req.headers);
    if (actor.kind !== "user") throw new UnauthenticatedError();
    const status = await sendEmailVerification(auth(), req.headers, actor.email);
    return ok({ status });
  },
  { limit: "emailVerification" },
);
