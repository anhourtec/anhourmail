// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { updateOwnProfile } from "@anhourmail/core/people";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service checks every value. */
const Body = z.object({ profile: z.record(z.string().max(32), z.string().max(400)).optional() });

/**
 * The person's own optional profile details (`self.profile.manage`): `{ profile }` replaces them (empty fields
 * clear). Recorded in each of their accounts' logs as the names of the fields that changed, never the values.
 */
export const PUT = route(async ({ req, meta }) => {
  const parsed = Body.safeParse((await readJson(req)) ?? {});
  return ok(
    await updateOwnProfile(
      container().deps,
      await getActor(req.headers),
      { profile: parsed.success ? parsed.data.profile : null },
      meta,
    ),
  );
});
