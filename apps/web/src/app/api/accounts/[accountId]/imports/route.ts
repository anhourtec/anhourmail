// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { can } from "@anhourmail/core";

import { listImports, startImport } from "@anhourmail/core/imports";

import { getActor, getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { enforceLimit, ok, readJson, route } from "@/server/http/route";
import { importContext, sendImportNotice } from "@/server/imports";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the values (and answers 404/403 before it looks at them). */
const Start = z.object({
  mailboxId: z.string().max(64).optional(),
  host: z.string().max(300).optional(),
  port: z.number().int().optional(),
  username: z.string().max(400).optional(),
  password: z.string().max(1100).optional(),
  options: z
    .object({
      excludeJunkTrash: z.boolean().optional(),
      intoSubfolder: z.boolean().optional(),
      sync: z.boolean().optional(),
    })
    .optional(),
});

/** The account's imports the caller may see (`mailbox.import.own`; every mailbox's with `mailbox.import.any`). */
export const GET = route(async ({ req }, params) =>
  ok(await listImports(container().deps, await getActor(req.headers), str(params.accountId))),
);

/**
 * Start an import into a mailbox (ADR-0030): `{ mailboxId, host, port, username, password, options }`. Needs a fresh
 * step-up (403 `step_up_required`). The old mailbox's password is sealed at once and never returned. An admin starting
 * one into someone else's mailbox emails that person.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = str(params.accountId);
    // 30 a day per account on top of the per-caller tier: each start mints a mail-server credential (fail closed),
    // counted only for callers who may import there, so nobody outside can use up an account's budget.
    if (can(actor, "mailbox.import.own", accountId)) await enforceLimit("importStartAccount", `account:${accountId}`);
    const parsed = Start.safeParse((await readJson(req)) ?? {});
    const out = await startImport(
      container().deps,
      importContext(),
      actor,
      accountId,
      // A malformed body still goes through the service, which answers 404/403 before it reads the input.
      parsed.success ? parsed.data : {},
      { sessionId },
      meta,
    );
    if (out.notice) await sendImportNotice(accountId, out.notice);
    return ok(out.import, 201);
  },
  { limit: "importStart" },
);
