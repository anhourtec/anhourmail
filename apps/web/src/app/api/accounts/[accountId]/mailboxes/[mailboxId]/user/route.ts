// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { hashPassword } from "@anhourmail/adapters/auth";
import { makeMailboxUser } from "@anhourmail/core/mailboxes";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const text = (max: number) => z.string().max(max).optional();

/** Shape only; the service checks every value (and answers 404/403 before looking at them). */
const Body = z.object({
  firstName: text(200),
  lastName: text(200),
  displayName: text(400),
  role: text(32),
  profile: z.record(z.string().max(32), z.string().max(400)).optional(),
});

/**
 * "Make this a user" (`mailbox.manage`, a role the caller may grant, and a recent step-up): turns a person-less
 * mailbox into a person who signs in with it (`makeMailboxUser`). The new generated password is in the response once
 * and nowhere else (never logged or audited). Other accounts' ids return 404.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const made = await makeMailboxUser(
      container().deps,
      actor,
      str(params.accountId),
      str(params.mailboxId),
      {
        firstName: body.firstName,
        lastName: body.lastName,
        displayName: body.displayName,
        role: body.role,
        profile: body.profile,
      },
      { sessionId },
      meta,
      container().passwords,
      hashPassword,
    );
    const res = ok(made, 201);
    // A generated password is in this body: never cache it anywhere.
    res.headers.set("Cache-Control", "no-store");
    return res;
  },
  { limit: "sensitive" },
);
