// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { deleteOwnLogin, loginDeletionPlan } from "@anhourmail/core/data";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { sendLoginDeleted } from "@/server/data-lifecycle";
import { ok, readJson, route } from "@/server/http/route";

/** Shape only; the service compares the typed address with the login's. */
const Delete = z.object({ confirmEmail: z.string().max(400).optional() });

/** What deleting one's own login would do and what stops it (`self.login.delete`; ADR-0025). */
export const GET = route(async ({ req }) => ok(await loginDeletionPlan(container().deps, await getActor(req.headers))));

/**
 * Delete one's own console login (`self.login.delete`): `{ confirmEmail }` must be the sign-in address (400), a fresh
 * step-up (403 `step_up_required`); 409 while an account depends on it. Empty accounts they alone own go with it. The
 * address is emailed a confirmation; the session cookie is cleared. `sensitive` tier (fail closed).
 */
export const DELETE = route(
  async ({ req, meta }) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Delete.safeParse((await readJson(req).catch(() => null)) ?? {});
    const out = await deleteOwnLogin(
      container().deps,
      actor,
      { confirmEmail: parsed.success ? parsed.data.confirmEmail : undefined },
      { sessionId },
      meta,
    );
    await sendLoginDeleted(out.email);
    const res = ok({ deleted: true, accountsDeleted: out.accountsDeleted, accountsLeft: out.accountsLeft });
    // The sessions are gone with the login; drop the browser's cookie too.
    for (const name of ["am.session_token", "__Secure-am.session_token"]) {
      res.cookies.set(name, "", {
        path: "/",
        maxAge: 0,
        httpOnly: true,
        sameSite: "lax",
        secure: name.startsWith("__Secure-"),
      });
    }
    return res;
  },
  { limit: "sensitive" },
);
