// SPDX-License-Identifier: AGPL-3.0-only
import { getMailboxDelegation, updateMailboxDelegation } from "@anhourmail/core/delegation";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * A mailbox's Delegation tab (`delegation.read`; ADR-0026 §5): who can read and manage it, send as it and send on
 * behalf of it, plus whether the viewer may change the lists. Another account's mailbox, or an unknown id, is 404.
 */
export const GET = route(async ({ req }, params) =>
  ok(
    await getMailboxDelegation(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
    ),
  ),
);

/**
 * Add people to and remove people from the three lists in one batch (`delegation.manage.any`):
 * `{ add: [{ userId, right }], remove: [{ userId, right }] }`, checked by the service against the shared
 * `delegationUpdateSchema` (`@anhourmail/shared/delegation`) after the permission and act-as checks. Guard rail 8 (an
 * Owner's or admin's mailbox needs an Owner), the plan and a fresh step-up on this console session (403
 * `step_up_required`) apply; 404 for a mailbox or person outside the account; 409 for the mailbox's own person, the
 * limits or a mailbox being deleted. Answers the lists as they now are; a grant works as soon as it commits.
 */
export const PATCH = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const body = await readJson(req);
    return ok(
      await updateMailboxDelegation(
        container().deps,
        actor,
        str(params.accountId),
        str(params.mailboxId),
        body,
        { sessionId },
        meta,
      ),
    );
  },
  { limit: "delegationManage" },
);
