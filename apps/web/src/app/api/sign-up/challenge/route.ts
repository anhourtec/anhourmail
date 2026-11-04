// SPDX-License-Identifier: AGPL-3.0-only
import { NotFoundError } from "@anhourmail/core";

import { signUpOpen } from "@/server/auth/instance";
import { newSignUpChallenge } from "@/server/auth/sign-up-gate";
import { ok, route } from "@/server/http/route";

/**
 * A sign-up proof-of-work challenge (ADR-0031): signed, single-use, bound to the caller's client address, valid for
 * `POW_TTL_SEC`. The sign-up page fetches one as it opens and solves it in a Web Worker. Public; 404 while sign-up is
 * closed. A POST (never cached, same-origin only); the body is ignored.
 */
export const POST = route(
  async ({ meta }) => {
    if (!signUpOpen()) throw new NotFoundError();
    const c = newSignUpChallenge(meta.ip);
    return ok({ challenge: c.challenge, bits: c.bits, expiresAt: c.expiresAt.toISOString() });
  },
  { limit: "signupChallenge" },
);
