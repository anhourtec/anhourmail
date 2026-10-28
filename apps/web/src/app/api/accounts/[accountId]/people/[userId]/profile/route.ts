// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { updatePersonProfile } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks every value. */
const Body = z.object({ profile: z.record(z.string().max(32), z.string().max(400)).optional() });

/**
 * "Edit profile" from the People page: `{ profile }` replaces the person's optional details (empty fields clear).
 * `member.manage` for a Member, an Owner for anyone else, and always the person themself. Someone outside the account
 * is a 404. The audit entry names the fields that changed, never their values.
 */
export const PUT = route(async ({ req, meta }, params) => {
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  const out = await updatePersonProfile(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    str(params.userId),
    { profile: parsed.success ? parsed.data.profile : null },
    meta,
  );
  return ok(out);
});
