// SPDX-License-Identifier: AGPL-3.0-only
import { removeAccountSafeSender } from "@anhourmail/core/webmail";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { scheduleAccountSafeSenders } from "@/server/webmail/account-safe-apply";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Removes one entry (`safe_sender.manage`); another account's id is a 404. Mailboxes follow in the background. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const accountId = str(params.accountId);
    const out = await removeAccountSafeSender(
      container().deps,
      await getActor(req.headers),
      { accountId, id: str(params.entryId) },
      meta,
    );
    scheduleAccountSafeSenders(accountId);
    return ok(out);
  },
  { limit: "accountSafeSenders" },
);
