// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { accountDeletionDetails, cancelAccountDeletion, requestAccountDeletion } from "@anhourmail/core/data";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { sendDeletionCancelled, sendDeletionScheduled } from "@/server/data-lifecycle";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service compares the typed name with the account's. */
const Request = z.object({ confirmName: z.string().max(400).optional() });

/** The account's pending deletion, or null (`account.read`; ADR-0025). The console notice reaches every member. */
export const GET = route(async ({ req }, params) =>
  ok(await accountDeletionDetails(container().deps, await getActor(req.headers), str(params.accountId))),
);

/**
 * Ask to delete the account (`account.delete`, Owners; ADR-0025): `{ confirmName }` must be its name (400), a fresh
 * step-up (403 `step_up_required`); 409 when already scheduled. Mailboxes are suspended now and everything is removed
 * after the grace period. Everyone in the account is emailed. `sensitive` tier (fail closed).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = str(params.accountId);
    const parsed = Request.safeParse((await readJson(req).catch(() => null)) ?? {});
    const out = await requestAccountDeletion(
      container().deps,
      actor,
      accountId,
      { confirmName: parsed.success ? parsed.data.confirmName : undefined },
      { sessionId },
      meta,
    );
    await sendDeletionScheduled(accountId, out);
    return ok({ deleteAfter: out.deleteAfter.toISOString(), mailboxesSuspended: out.mailboxesSuspended });
  },
  { limit: "sensitive" },
);

/** Cancel a pending deletion before its grace period ends (`account.delete`): suspended mailboxes resume. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const out = await cancelAccountDeletion(container().deps, await getActor(req.headers), str(params.accountId), meta);
    await sendDeletionCancelled(out);
    return ok({ cancelled: true });
  },
  { limit: "sensitive" },
);
