// SPDX-License-Identifier: AGPL-3.0-only
import { UnauthenticatedError } from "@anhourmail/core";
import { revokeOtherSessions } from "@anhourmail/core/security";

import { getActorAndSession } from "@/server/auth/actor";
import { announcePasskeysRemoved } from "@/server/auth/instance";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * Signs out every other session of the person and forgets trusted devices (`self.security.manage`). Body
 * `{ "removePasskeys": true }` also removes every passkey (refused, 409, when an account requirement depends on them;
 * 403 `step_up_required` without a fresh "Confirm it's you", ADR-0028).
 */
export const DELETE = route(
  async ({ req, meta }) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    if (!sessionId) throw new UnauthenticatedError();
    const text = await req.text();
    const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown> | null;
    const removePasskeys = body?.removePasskeys === true;
    const out = await revokeOtherSessions(
      container().deps,
      actor,
      { currentSessionId: sessionId, removePasskeys },
      meta,
    );
    if (out.passkeysRemoved > 0 && actor.kind === "user") {
      await announcePasskeysRemoved(
        { userId: actor.userId, email: actor.email, passkeysRemoved: out.passkeysRemoved, via: "sign_out_everywhere" },
        meta,
      );
    }
    return ok(out);
  },
  { limit: "sensitive" },
);
