// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { checkJmapRequest, MAX_REQUEST_BYTES } from "@/server/webmail/jmap-policy";
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
      const check = checkJmapRequest(JSON.parse(text) as unknown, s.accountId);
      if (!check.ok) return badRequest(check.message);
      const res = await webmail().jmap(id, check.body);
      return NextResponse.json(res.body, { status: res.status });
    });
  },
  { session: "webmail", limit: "webmail" },
);
