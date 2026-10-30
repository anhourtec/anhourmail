// SPDX-License-Identifier: AGPL-3.0-only
import { ValidationError } from "@anhourmail/core";
import { changeMemberRole, removeMember } from "@anhourmail/core/people";
import { firstIssue, memberRemovalSchema } from "@anhourmail/shared/delegation";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, readOptionalJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Change someone's role (`account.admins.manage`: Owners). Not your own; never the last Owner (409). */
export const PATCH = route(
  async ({ req, meta }, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    return ok(
      await changeMemberRole(
        container().deps,
        await getActor(req.headers),
        str(params.accountId),
        str(params.userId),
        { role: body.role },
        meta,
      ),
    );
  },
  { limit: "sensitive" },
);

/**
 * Remove someone (`member.manage`; an Owner or admin needs an Owner). Their mailboxes stay, person-less, with their
 * sign-in turned off (a new password nobody is shown, app passwords revoked). Optional body
 * `{ delegateTo: { userId, sendAs } }` (shared `memberRemovalSchema`; ADR-0026 §5): that person gets read and manage
 * (and send as) on each of the leaver's mailboxes in the removal's own transaction; that part needs
 * `delegation.manage.any` for every one of those mailboxes and a fresh step-up on this console session (403 otherwise,
 * and nothing is removed — the dialog then offers the removal without it). No body: the removal alone.
 */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = memberRemovalSchema.safeParse((await readOptionalJson(req)) ?? {});
    if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
    return ok(
      await removeMember(
        container().deps,
        actor,
        str(params.accountId),
        str(params.userId),
        meta,
        container().passwords,
        { delegateTo: parsed.data.delegateTo, session: { sessionId } },
      ),
    );
  },
  { limit: "sensitive" },
);
