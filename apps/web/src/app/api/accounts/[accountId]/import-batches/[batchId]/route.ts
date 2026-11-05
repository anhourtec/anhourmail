// SPDX-License-Identifier: AGPL-3.0-only
import { getImportBatch } from "@anhourmail/core/imports";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** One admins' batch and its imports (`mailbox.import.any`); another account's batch id is 404. */
export const GET = route(async ({ req }, params) =>
  ok(await getImportBatch(container().deps, await getActor(req.headers), str(params.accountId), str(params.batchId))),
);
