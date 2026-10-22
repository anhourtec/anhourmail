// SPDX-License-Identifier: AGPL-3.0-only
import { setSignInPolicy } from "@anhourmail/core/security";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * What everyone in the account must use to sign in: `none`, `two_factor` or `passkey` (`account.security.manage`,
 * Owners). The Owner must meet it themselves first (409).
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    return ok(
      await setSignInPolicy(
        container().deps,
        await getActor(req.headers),
        { accountId: str(params.accountId), policy: body.policy },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);
