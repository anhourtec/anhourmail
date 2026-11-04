// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { chooseHolds } from "@anhourmail/core/billing";

import { getActor } from "@/server/auth/actor";
import { paramOf } from "@/server/billing";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service checks ids and that the choice fits Free. */
const Body = z.object({
  mailboxId: z.string().max(64).optional(),
  aliasIds: z.array(z.string().max(64)).max(1000).optional(),
});

/**
 * "Choose what stays on" after the paid plan ended (`billing.manage` ★; ADR-0029 §6): `{ mailboxId?, aliasIds? }`, the
 * platform-domain mailbox Free keeps and which of its aliases stay on. What isn't kept is held, never deleted. Only
 * while the account is lapsed (400 `invalid_change` otherwise).
 */
export const PUT = route(async ({ req, meta }, params) => {
  const actor = await getActor(req.headers);
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  return ok(
    await chooseHolds(
      container().deps,
      actor,
      paramOf(params.accountId),
      parsed.success ? parsed.data : { mailboxId: "invalid" },
      meta,
    ),
  );
});
