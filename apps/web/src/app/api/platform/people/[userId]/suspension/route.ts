// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { liftPersonSuspension, suspendPerson } from "@anhourmail/core/platform";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendSuspensionNotices } from "@/server/mail/suspension-email";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the reason category and the note. */
const Suspend = z.object({ reason: z.string().max(32).optional(), note: z.string().max(4000).optional() });

/**
 * Staff: suspend a person's console sign-in (`platform.account.suspend`, Global Administrator): `{ reason, note? }`.
 * Their sessions end and their mailboxes are suspended. Fresh step-up, never while acting as someone; staff and
 * yourself are refused (409); unknown people 404. The person is emailed (never the note). `staffSuspend` tier.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Suspend.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const out = await suspendPerson(
      container().deps,
      actor,
      str(params.userId),
      { reason: body.reason, note: body.note },
      { sessionId },
      meta,
    );
    await sendSuspensionNotices([out.email], { subject: "person", state: "suspended", reason: out.reason });
    return ok({ suspended: true, mailboxes: out.mailboxes });
  },
  { limit: "staffSuspend" },
);

/** Staff: lift the person's suspension (same rules); 409 when they aren't suspended. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const out = await liftPersonSuspension(container().deps, actor, str(params.userId), { sessionId }, meta);
    await sendSuspensionNotices([out.email], { subject: "person", state: "restored", reason: out.reason });
    return ok({ suspended: false, mailboxes: out.mailboxes });
  },
  { limit: "staffSuspend" },
);
