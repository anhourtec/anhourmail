// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { startActAs } from "@anhourmail/core/platform";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendActAsNotices } from "@/server/mail/act-as-email";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service trims and checks the reason. */
const Start = z.object({ reason: z.string().max(4000).optional() });

/**
 * Staff: start read-only support access to a customer account (`platform.accounts.actAs`, Global and Support
 * Administrators; ADR-0023): `{ reason }`. Needs a fresh step-up (403 `step_up_required`); unknown accounts 404; staff
 * accounts 403; suspended accounts and a second open session 409. The account's Owners are emailed. `sensitive` tier
 * (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Start.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const out = await startActAs(
      container().deps,
      actor,
      str(params.accountId),
      { reason: body.reason },
      { sessionId },
      meta,
    );
    await sendActAsNotices(
      out.notify.map((n) => n.email),
      { accountId: out.session.accountId, reason: out.session.reason, startedAt: out.session.startedAt },
    );
    return ok({ accountId: out.session.accountId, expiresAt: out.session.expiresAt.toISOString() });
  },
  { limit: "sensitive" },
);
