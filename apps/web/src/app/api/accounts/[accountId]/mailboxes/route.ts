// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { can } from "@anhourmail/core";
import { createMailbox, listMailboxes, PLATFORM_DOMAIN_ID } from "@anhourmail/core/mailboxes";
import { MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { enforceLimit, ok, readJson, route } from "@/server/http/route";

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
 * Create a mailbox on an active domain, or a free address on the platform domain (`domainId: "platform"`), with
 * `mailbox.manage` and the password its person signs in with. The password is hashed (argon2id) in the service and
 * only the hash goes to the worker, which creates the account on the mail server. A free address is also limited per
 * account and per client address (fail closed; rate-limits.md), counted before the service looks at anything.
 */
export const POST = route(async ({ req, meta }, params) => {
  const parsed = Create.safeParse((await readJson(req)) ?? {});
  const body = parsed.success ? parsed.data : {};
  const accountId = str(params.accountId);
  const actor = await getActor(req.headers);
  if (body.domainId === PLATFORM_DOMAIN_ID && actor.kind === "user") {
    await enforceLimit("platformMailboxIp", `ip:${meta.ip ?? "direct"}`);
    // Only someone who may create mailboxes there spends the account's budget (an outsider can't use it up; the
    // service answers them 404/403).
    if (can(actor, "mailbox.manage", accountId)) await enforceLimit("platformMailboxAccount", `account:${accountId}`);
  }
  const mailbox = await createMailbox(
    container().deps,
    actor,
    accountId,
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
