// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { createInviteCode } from "@anhourmail/core/billing";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service checks what the code grants, its expiry and the bound address. */
const Body = z.object({
  label: z.string().max(400).optional(),
  grantsSignup: z.boolean().optional(),
  compPlan: z.union([z.string().max(20), z.null()]).optional(),
  compDays: z.union([z.number(), z.null()]).optional(),
  email: z.union([z.string().max(320), z.null()]).optional(),
  expiresInDays: z.number().optional(),
});

/**
 * Staff: create an invite code (ADR-0029 §8) → `{ code, invite }`; the code is shown this once. Every staff role passes
 * this gate; the service then needs `platform.invites.manage` for a sign-up-only code or `platform.billing.manage` ★
 * (with a fresh step-up) for one that comps a plan. Tier `sensitive` (fail closed).
 */
export const POST = route(
  async ({ req, meta }) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    return ok(await createInviteCode(container().deps, actor, parsed.success ? parsed.data : {}, { sessionId }, meta));
  },
  { limit: "sensitive" },
);
