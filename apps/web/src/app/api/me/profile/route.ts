// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { type Actor, UnauthenticatedError, ValidationError } from "@anhourmail/core";
import { updateOwnProfile } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

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
 * The person's own profile (`self.profile.manage`): `{ profile }` replaces their optional details (empty fields clear);
 * `{ name }` changes their name, which is also the sender name of their mailboxes that follow it (`people/names.ts`).
 * Either or both. Recorded in each of their accounts' logs as the names of the fields that changed, never the values.
 */
export const PUT = route(async ({ req, meta }) => {
  const actor = await getActor(req.headers);
  const input = body(actor, await readJson(req));
  return ok(await updateOwnProfile(container().deps, actor, input, meta));
});
