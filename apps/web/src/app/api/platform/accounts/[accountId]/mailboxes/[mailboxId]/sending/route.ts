// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { setMailboxRestriction } from "@anhourmail/core/trust";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendRestrictionNotices } from "@/server/mail/restriction-email";
import { scheduleSendingPause } from "@/server/webmail/sending-pause-apply";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks every field. */
const Restrict = z.object({
  restricted: z.boolean().optional(),
  reason: z.string().max(32).optional(),
  note: z.string().max(4000).optional(),
});

/**
 * Staff: restrict or lift one mailbox's sending (`platform.trust.manage`, ADR-0034 §6): `{ restricted, reason, note }`.
 * The same step-up, act-as and reason rules as the account's tier; a mailbox that isn't this account's is 404; already
 * in that state 409. Afterwards the mailbox's managed script follows (redirects and replies paused or back), and a
 * restriction emails the account's Owners and administrators (at most one mailbox notice a day per account; sent
 * after answering, retried, a give-up audited). The body is never logged. `staffTrust` tier (fail closed).
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Restrict.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const accountId = str(params.accountId);
    const out = await setMailboxRestriction(
      container().deps,
      actor,
      accountId,
      str(params.mailboxId),
      { restricted: body.restricted, reason: body.reason, note: body.note },
      { sessionId },
      meta,
    );
    scheduleSendingPause(accountId);
    // Restricted now: the account's Owners and administrators are told (at most once a day; the service decides who).
    // Sent after answering, with retries; it never throws and records a give-up itself.
    void sendRestrictionNotices(
      out.notice,
      out.notify.map((n) => n.email),
      { address: out.address, reason: out.reason },
      meta,
    );
    return ok({ address: out.address, restricted: out.restricted, reason: out.reason });
  },
  { limit: "staffTrust" },
);
