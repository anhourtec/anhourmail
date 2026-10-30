// SPDX-License-Identifier: AGPL-3.0-only
import { convertMailboxToShared } from "@anhourmail/core/mailboxes";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readOptionalJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * "Convert to shared mailbox" (`mailbox.manage`, a fresh step-up; ADR-0026 §3): `{ fullAccessTo?: userId[], sendAs? }`,
 * checked by the service against the shared `convertToSharedSchema`. The mailbox keeps its mail and address; nobody
 * signs in to it any more (a new password nobody is shown is queued for the mail server, its app passwords revoked) and
 * the people named get read and manage (and send as) in the same change, which also needs `delegation.manage.any`.
 * 202: the password replacement is a job. 404 for another account's mailbox; 409 when it is already shared, being
 * deleted or still being set up.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const body = await readOptionalJson(req);
    return ok(
      await convertMailboxToShared(
        container().deps,
        actor,
        str(params.accountId),
        str(params.mailboxId),
        body,
        { sessionId },
        meta,
        container().passwords,
      ),
      202,
    );
  },
  { limit: "delegationManage" },
);
