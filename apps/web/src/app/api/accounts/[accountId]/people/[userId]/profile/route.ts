// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { type Actor, UnauthenticatedError, ValidationError } from "@anhourmail/core";
import { updatePersonProfile } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks every value. */
const Body = z.object({
  profile: z.record(z.string().max(32), z.string().max(400)).optional(),
  name: z.string().max(400).optional(),
});

/**
 * The body, or a 400 when it isn't that shape (401 first when signed out): a malformed edit must never reach the service
 * as "no details", which would clear every field.
 */
function body(actor: Actor, raw: unknown): z.infer<typeof Body> {
  const parsed = Body.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  if (actor.kind === "anonymous") throw new UnauthenticatedError();
  const issue = parsed.error.issues[0];
  throw new ValidationError(
    issue?.path[0] === "name" && issue.code === "too_big"
      ? "That name is too long."
      : "Check the profile details and try again.",
  );
}

/**
 * "Edit profile" from the People page: `{ profile }` replaces the person's optional details (empty fields clear);
 * `{ name }` changes their name (the sender name of their mailboxes that follow it).
 * `member.manage` for a Member, an Owner for anyone else, and always the person themself. Someone outside the account
 * is a 404. The audit entry names the fields that changed, never their values.
 */
export const PUT = route(async ({ req, meta }, params) => {
  const actor = await getActor(req.headers);
  const input = body(actor, await readJson(req));
  const out = await updatePersonProfile(
    container().deps,
    actor,
    str(params.accountId),
    str(params.userId),
    input,
    meta,
  );
  return ok(out);
});
