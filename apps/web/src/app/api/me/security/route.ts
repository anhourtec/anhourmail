// SPDX-License-Identifier: AGPL-3.0-only
import { getSecurityOverview } from "@anhourmail/core/security";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * The person's own Security page data (`self.security.manage`): factors, passkeys, sessions, recent sign-in and
 * security activity, and what their accounts require. Never secrets, tokens or full addresses.
 */
export const GET = route(async ({ req }) => {
  const { actor, sessionId } = await getActorAndSession(req.headers);
  return ok(await getSecurityOverview(container().deps, actor, { currentSessionId: sessionId }));
});
