// SPDX-License-Identifier: AGPL-3.0-only
import { revokeSession } from "@anhourmail/core/security";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Signs out one of the person's other sessions (`self.security.manage`). Someone else's session id is a 404. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    await revokeSession(
      container().deps,
      actor,
      { sessionId: str(params.sessionId), currentSessionId: sessionId },
      meta,
    );
    return ok({ revoked: true });
  },
  { limit: "sensitive" },
);
