// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { staffCreatePlatformMailbox } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the values (and answers 403/404 before looking at them). */
const Create = z.object({
  localPart: z.string().max(256).optional(),
  ownerUserId: z.string().max(128).optional(),
});

/**
 * Staff: create a free platform-domain address in a customer account (`platform.mailbox.create`, Global
 * Administrator). No password is set: the account's Owner or User Administrator sets one. Recorded in the account's
 * own audit log as a staff action; refusals in the platform log; unknown accounts 404. `sensitive` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const parsed = Create.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const mailbox = await staffCreatePlatformMailbox(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      { localPart: body.localPart, ownerUserId: body.ownerUserId },
      meta,
    );
    return ok(mailbox, 201);
  },
  { limit: "sensitive" },
);
