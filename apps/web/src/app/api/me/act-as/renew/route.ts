// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { renewActAs } from "@anhourmail/core/platform";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service trims and checks the reason. */
const Renew = z.object({ reason: z.string().max(4000).optional() });

/**
 * Extend your open support access (ADR-0023): `{ reason }` (a new one), fresh step-up (403 `step_up_required`), never
 * past four hours from its start (409). 404 when none is open. `sensitive` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Renew.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const out = await renewActAs(container().deps, actor, { reason: body.reason }, { sessionId }, meta);
    return ok({ expiresAt: out.expiresAt.toISOString() });
  },
  { limit: "sensitive" },
);
