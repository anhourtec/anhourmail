// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { createMailbox, listMailboxes } from "@anhourmail/core/mailboxes";
import { MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the values (and answers 404/403 before looking at them). */
const Create = z.object({
  localPart: z.string().max(256).optional(),
  domainId: z.string().max(64).optional(),
  ownerUserId: z.string().max(128).optional(),
  quotaGb: z.union([z.string().max(16), z.number()]).optional(),
  // Generous bound so the service can say what's wrong; the rules (12–128 characters, …) live in the service.
  password: z
    .string()
    .max(MAILBOX_PASSWORD.max * 4)
    .optional(),
});

/** The account's mailboxes (`mailbox.read`). Other accounts' ids return 404. */
export const GET = route(async ({ req }, params) =>
  ok(await listMailboxes(container().deps, await getActor(req.headers), str(params.accountId))),
);

/**
 * Create a mailbox on an active domain (`mailbox.manage`) with the password its person signs in with. The password is
 * hashed (argon2id) in the service and only the hash goes to the worker, which creates the account on the mail server.
 */
export const POST = route(async ({ req, meta }, params) => {
  const parsed = Create.safeParse((await readJson(req)) ?? {});
  const body = parsed.success ? parsed.data : {};
  const mailbox = await createMailbox(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    {
      localPart: body.localPart,
      domainId: body.domainId,
      ownerUserId: body.ownerUserId,
      quotaGb: body.quotaGb,
      password: body.password,
    },
    meta,
    container().passwords,
  );
  return ok(mailbox, 201);
});
