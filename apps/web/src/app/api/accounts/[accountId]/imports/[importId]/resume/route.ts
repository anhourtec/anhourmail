// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { can } from "@anhourmail/core";

import { resumeImport } from "@anhourmail/core/imports";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { enforceLimit, ok, readOptionalJson, route } from "@/server/http/route";
import { importContext } from "@/server/imports";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const Resume = z.object({ password: z.string().max(1100).optional() });

/**
 * Resume a paused or blocked import: `{ password? }` (a new app password for the old mailbox). Needs a fresh step-up:
 * it may mint a new mail-server credential.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = str(params.accountId);
    // Counted only for callers who may import there, so nobody outside can use up an account's budget.
    if (can(actor, "mailbox.import.own", accountId)) await enforceLimit("importStartAccount", `account:${accountId}`);
    const parsed = Resume.safeParse((await readOptionalJson(req)) ?? {});
    return ok(
      await resumeImport(
        container().deps,
        importContext(),
        actor,
        accountId,
        str(params.importId),
        parsed.success ? parsed.data : {},
        { sessionId },
        meta,
      ),
    );
  },
  { limit: "importStart" },
);
