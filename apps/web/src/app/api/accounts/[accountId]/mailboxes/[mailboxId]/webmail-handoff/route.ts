// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { startWebmailHandoff } from "@anhourmail/core/webmail";
import { WEBMAIL_HANDOFF_PAGE } from "@anhourmail/shared/webmail";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { ok, readJson, route } from "@/server/http/route";
import { handoffAccess, redisHandoffCodes } from "@/server/webmail/handoff";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Shape only; the service checks the value (after 404/403, so a probe learns nothing from it). */
const Body = z.object({ challenge: z.string().max(64).optional() });

/**
 * Console → webmail handoff, step 2 (ADR-0024): a one-time code for one of the caller's own mailboxes
 * (`webmail.open.own`), bound to this console session and to the challenge the webmail origin gave this browser. The
 * answer is the webmail page to open with the code in the URL fragment (never sent to a server). 404 for any mailbox
 * that isn't the caller's, 403 while acting as someone, 409 `handoff_refused` when it can't be opened now.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const parsed = Body.safeParse((await readJson(req)) ?? {});
    const out = await startWebmailHandoff(
      container().deps,
      redisHandoffCodes(),
      handoffAccess(),
      actor,
      str(params.accountId),
      str(params.mailboxId),
      { challenge: parsed.success ? parsed.data.challenge : null },
      { sessionId },
      meta,
    );
    const page = `${env().WEBMAIL_URL.replace(/\/+$/, "")}${WEBMAIL_HANDOFF_PAGE}`;
    return ok({ url: `${page}#${out.code}`, expiresAt: out.expiresAt.toISOString() }, 201);
  },
  { limit: "webmailHandoff" },
);
