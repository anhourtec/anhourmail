// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { liftAccountSuspension, suspendAccount } from "@anhourmail/core/platform";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendSuspensionNotices } from "@/server/mail/suspension-email";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the reason category and the note. */
const Suspend = z.object({ reason: z.string().max(32).optional(), note: z.string().max(4000).optional() });

/**
 * Staff: suspend a customer account (`platform.account.suspend`, Global Administrator): `{ reason, note? }`. Needs a
 * fresh step-up (403 `step_up_required`), refused while acting as someone; unknown accounts 404; already suspended
 * 409. Its Owners and administrators are emailed (never the internal note). `staffSuspend` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Suspend.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const out = await suspendAccount(
      container().deps,
      actor,
      str(params.accountId),
      { reason: body.reason, note: body.note },
      { sessionId },
      meta,
    );
    await sendSuspensionNotices(
      out.notify.map((n) => n.email),
      { subject: "account", state: "suspended", reason: out.reason },
    );
    return ok({ suspended: true, mailboxes: out.mailboxes });
  },
  { limit: "staffSuspend" },
);

/** Staff: lift the account's suspension (same permission, step-up and act-as rules); 409 when it isn't suspended. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const out = await liftAccountSuspension(container().deps, actor, str(params.accountId), { sessionId }, meta);
    await sendSuspensionNotices(
      out.notify.map((n) => n.email),
      { subject: "account", state: "restored", reason: out.reason },
    );
    return ok({ suspended: false, mailboxes: out.mailboxes });
  },
  { limit: "staffSuspend" },
);
