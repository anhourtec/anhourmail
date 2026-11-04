// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { can, ValidationError } from "@anhourmail/core";
import { addAccountSafeSenders, listAccountSafeSenders } from "@anhourmail/core/webmail";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { scheduleAccountSafeSenders } from "@/server/webmail/account-safe-apply";
import { BodyTooLargeError, readCappedText } from "@/server/webmail/http";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Largest request body: a pasted list of up to 100 entries of 254 characters, JSON-escaped. */
const MAX_BODY = 64 * 1024;

/** The account-wide Safe senders list (ADR-0032 §1; `safe_sender.read`). */
export const GET = route(async ({ req }, params) =>
  ok(await listAccountSafeSenders(container().deps, await getActor(req.headers), { accountId: str(params.accountId) })),
);

/**
 * Adds entries (`{ entries: string[] }`, `safe_sender.manage`). Once committed, the web app writes the list into every
 * mailbox's managed script in the background (`account-safe-apply.ts`).
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    const accountId = str(params.accountId);
    // The body is read only for someone who may change the list; anyone else gets the service's refusal (audited).
    let body: unknown = null;
    if (can(actor, "safe_sender.manage", accountId)) {
      try {
        body = JSON.parse(await readCappedText(req, MAX_BODY));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return NextResponse.json(
            { error: { code: "too_large", message: "Add up to 100 entries at a time." } },
            { status: 413 },
          );
        }
        throw new ValidationError("Request body must be JSON.");
      }
    }
    const entries = typeof body === "object" && body !== null ? (body as { entries?: unknown }).entries : undefined;
    const out = await addAccountSafeSenders(container().deps, actor, { accountId, entries }, meta);
    if (out.added > 0) scheduleAccountSafeSenders(accountId);
    return ok(out, 201);
  },
  { limit: "accountSafeSenders" },
);
