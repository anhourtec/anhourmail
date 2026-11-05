// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { normaliseInviteCode, redeemInviteCode } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { enforceLimit, ok, readJson, route } from "@/server/http/route";

const Body = z.object({ code: z.string().max(64) });

/**
 * Redeems a comp code on the Billing page (`billing.manage` ★; ADR-0029 §8): `{ code }` → the plan and its end. Only on
 * Free or after a lapse (409 `already_subscribed`); every wrong code is the same 404 `invite_code_invalid`. Tier
 * `inviteCodeRedeem` per caller, and `inviteCodeRedeemIp` per client address for anything shaped like a code (both fail
 * closed: each entry is a guess).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    // Anything that could be a code is a guess: counted per client address as well as per caller (the route's tier).
    if (parsed.success && normaliseInviteCode(parsed.data.code) !== null) {
      await enforceLimit("inviteCodeRedeemIp", `ip:${meta.ip ?? "direct"}`);
    }
    return ok(
      await redeemInviteCode(
        container().deps,
        actor,
        paramOf(params.accountId),
        { code: parsed.success ? parsed.data.code : null },
        meta,
      ),
    );
  },
  { limit: "inviteCodeRedeem" },
);
