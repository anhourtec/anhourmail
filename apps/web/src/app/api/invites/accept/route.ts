// SPDX-License-Identifier: AGPL-3.0-only
import { hashPassword } from "@anhourmail/adapters/auth";
import { acceptInvite } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/**
 * Accept an invite with the token from its link (in the body, never the URL, so it isn't logged). Signed in: joins as
 * the session's person, whose email must be the invited one. Signed out: creates the console login for the invited
 * address first (names + a password, refused when it has appeared in a data breach). Guessing tokens is rate-limited per IP and fails closed (`auth` tier).
 */
export const POST = route(
  async ({ req, meta }) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const out = await acceptInvite(
      container().deps,
      await getActor(req.headers),
      { token: body.token, firstName: body.firstName, lastName: body.lastName, password: body.password },
      meta,
      hashPassword,
      container().breaches,
    );
    return ok(out);
  },
  { limit: "auth" },
);
