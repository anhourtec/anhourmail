// SPDX-License-Identifier: AGPL-3.0-only
import { getMailbox, setMailboxQuota } from "@anhourmail/core/mailboxes";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** One mailbox (`mailbox.read`). */
export const GET = route(async ({ req }, params) =>
  ok(await getMailbox(container().deps, await getActor(req.headers), str(params.accountId), str(params.mailboxId))),
);

/** Change the quota (`mailbox.manage`): `{ quotaGb }`. */
export const PATCH = route(async ({ req, meta }, params) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  return ok(
    await setMailboxQuota(
      container().deps,
      await getActor(req.headers),
      str(params.accountId),
      str(params.mailboxId),
      { quotaGb: body.quotaGb },
      meta,
    ),
  );
});
