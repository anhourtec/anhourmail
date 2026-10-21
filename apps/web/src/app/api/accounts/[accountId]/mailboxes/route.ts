// SPDX-License-Identifier: AGPL-3.0-only
import { createMailbox, listMailboxes } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** The account's mailboxes (`mailbox.read`). Other accounts' ids return 404. */
export const GET = route(async ({ req }, params) =>
  ok(await listMailboxes(container().deps, await getActor(req.headers), str(params.accountId))),
);

/** Create a mailbox on an active domain (`mailbox.manage`); the worker creates it on the mail server. */
export const POST = route(async ({ req, meta }, params) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const mailbox = await createMailbox(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    { localPart: body.localPart, domainId: body.domainId, ownerUserId: body.ownerUserId, quotaGb: body.quotaGb },
    meta,
  );
  return ok(mailbox, 201);
});
