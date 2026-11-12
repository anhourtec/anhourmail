// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { setAccountTier, staffAccountTrust } from "@anhourmail/core/trust";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";
import { sendRestrictionNotices } from "@/server/mail/restriction-email";
import { scheduleSendingPause } from "@/server/webmail/sending-pause-apply";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the tier, the reason category, the note and `automatic`. */
const SetTier = z.object({
  tier: z.string().max(32).optional(),
  reason: z.string().max(32).optional(),
  note: z.string().max(4000).optional(),
  automatic: z.boolean().optional(),
});

/**
 * Staff: an account's trust tier with its source, dates and reason, and each mailbox's sending restriction
 * (`platform.accounts.read`); the internal notes only with `platform.suspensionNotes.read`. Unknown account → 404.
 */
export const GET = route(async ({ req }, params) => {
  const actor = await getActor(req.headers);
  return ok(await staffAccountTrust(container().deps, actor, str(params.accountId)));
});

/**
 * Staff: set an account's tier (`platform.trust.manage`: Global and Trust & Safety Administrators, ADR-0034 §2):
 * `{ tier: "new" | "standard" | "restricted", reason?, note, automatic? }`. A fresh step-up (403 `step_up_required`),
 * never while acting as someone (403); a reason category to restrict and to move off `restricted`; a note always;
 * `trusted` is 422 `tier_unavailable`; unknown accounts 404; the same tier and source 409. Afterwards each mailbox's
 * managed script follows the new tier (redirects and replies paused or back), and a restriction emails the account's
 * Owners and administrators the reason category and the appeal address (never the note; at most one account notice a
 * day; sent after answering, retried, a give-up audited). The body
 * is never logged: the note is staff-only. `staffTrust` tier (fail closed).
 */
export const PUT = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = SetTier.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const accountId = str(params.accountId);
    const out = await setAccountTier(
      container().deps,
      actor,
      accountId,
      { tier: body.tier, reason: body.reason, note: body.note, automatic: body.automatic },
      { sessionId },
      meta,
    );
    scheduleSendingPause(accountId);
    // Restricted now: its Owners and administrators are told (at most once a day; the service decides who). Sent
    // after answering, with retries; it never throws and records a give-up itself.
    if (out.reason !== null) {
      void sendRestrictionNotices(
        out.notice,
        out.notify.map((n) => n.email),
        { reason: out.reason },
        meta,
      );
    }
    return ok({
      tier: out.to,
      from: out.from,
      source: out.source,
      reason: out.reason,
      mailboxesQueued: out.mailboxesQueued,
    });
  },
  { limit: "staffTrust" },
);
