// SPDX-License-Identifier: AGPL-3.0-only
import { listPersonDelegations } from "@anhourmail/core/delegation";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * "Mailboxes they can open" on a person's panel (`delegation.read`; ADR-0026 §5): every mailbox in the account the
 * person holds a right on, with those rights. Someone outside the account (or an unknown id) is 404.
 */
export const GET = route(async ({ req }, params) =>
  ok(
    await listPersonDelegations(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.userId),
    ),
  ),
);
