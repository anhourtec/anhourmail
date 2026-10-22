// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { createAppPassword, listMailboxAppPasswords, revokeAppPasswords } from "@anhourmail/core/app-passwords";
import { APP_PASSWORD_NAME_MAX, APP_PASSWORD_PROTOCOLS } from "@anhourmail/shared/security";

import { appPasswordIssuer } from "@/server/adapters/stalwart";
import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendAppPasswordNotice } from "@/server/mail/app-password-email";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the values (and answers 404/403 before looking at them). */
const Create = z.object({
  name: z
    .string()
    .max(APP_PASSWORD_NAME_MAX * 4)
    .optional(),
  protocols: z.array(z.enum(APP_PASSWORD_PROTOCOLS)).max(APP_PASSWORD_PROTOCOLS.length).optional(),
});

/** One mailbox's app passwords for people who can see mailboxes (`mailbox.read`): names and dates, no secrets. */
export const GET = route(async ({ req }, params) =>
  ok(
    await listMailboxAppPasswords(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
    ),
  ),
);

/**
 * Create an app password on one's own mailbox (`app_password.manage.own`): `{ name, protocols }`. Needs a recent
 * step-up (403 `step_up_required` otherwise). The secret is in this response only; the person is emailed a notice.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Create.safeParse((await readJson(req)) ?? {});
    const accountId = str(params.accountId);
    const created = await createAppPassword(
      container().deps,
      appPasswordIssuer(),
      actor,
      accountId,
      str(params.mailboxId),
      // A malformed body still goes through the service, which answers 404/403 before it reads the input.
      parsed.success ? { name: parsed.data.name, protocols: parsed.data.protocols } : { name: null, protocols: null },
      { sessionId },
      meta,
    );
    if (actor.kind === "user") await sendAppPasswordNotice(actor.email, accountId, created);
    return ok(created, 201);
  },
  { limit: "sensitive" },
);

/** Revoke every app password of the mailbox (`app_password.manage.own` on one's own; `mailbox.manage` on others). */
export const DELETE = route(async ({ req, meta }, params) => {
  const actor = await getActor(req.headers);
  return ok(
    await revokeAppPasswords(container().deps, actor, str(params.accountId), str(params.mailboxId), null, meta),
  );
});
