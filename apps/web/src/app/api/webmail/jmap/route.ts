// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { checkJmapRequest, MAX_REQUEST_BYTES, writesEmail } from "@/server/webmail/jmap-policy";
import { BodyTooLargeError, badRequest, handleWebmail, readCappedText, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * The same-origin JMAP proxy (ADR-0003): checks the request against the allow-list, attaches the person's token
 * server-side and forwards it through their ≤ 4-in-flight queue. Bodies pass through untouched and are never logged
 * (CLAUDE.md rule 24). Answers are JMAP protocol documents, not the `{ data }` envelope.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    let text: string;
    try {
      text = await readCappedText(req, MAX_REQUEST_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json({ error: { code: "too_large", message: "Request too large." } }, { status: 413 });
      }
      throw err;
    }
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      const parsed = JSON.parse(text) as unknown;
      // The Drafts folder matters only to `Email/set` (nothing may be moved into it): a read-only request doesn't wait
      // for the folder roles (a mail-server call when they aren't cached).
      const roles = writesEmail(parsed) ? await webmail().roles(id) : {};
      const check = checkJmapRequest(parsed, s.accountId, {
        draftsId: roles.drafts,
        // A mailbox shared with the person (ADR-0026 §6): no send right is used yet (slice 13).
        ...(s.delegated ? { delegated: { send: false } } : {}),
      });
      if (!check.ok) return badRequest(check.message);
      const res = await webmail().jmap(id, check.body, check.destroyIds);
      return NextResponse.json(res.body, { status: res.status });
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
