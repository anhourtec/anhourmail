// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { jmapSessionDocument } from "@/server/webmail/jmap-session";

/**
 * The JMAP Session resource (RFC 8620 §2) as the browser sees it: a protocol document, not our `{ data }`
 * envelope. URLs point at this origin's proxy; Stalwart's real URLs and the token never reach the browser.
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      const s = await webmail().session(id);
      if (!s) return unauthorized();
      return NextResponse.json(jmapSessionDocument(s));
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
