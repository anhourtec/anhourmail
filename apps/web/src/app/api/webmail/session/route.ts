// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { route } from "@/server/http/route";
import { MAX_CALLS, MAX_REQUEST_BYTES } from "@/server/webmail/jmap-policy";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

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
      return NextResponse.json({
        capabilities: {
          "urn:ietf:params:jmap:core": {
            maxSizeUpload: 0,
            maxConcurrentUpload: 0,
            maxSizeRequest: MAX_REQUEST_BYTES,
            maxConcurrentRequests: 4,
            maxCallsInRequest: MAX_CALLS,
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
            collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
          },
          "urn:ietf:params:jmap:mail": {},
        },
        accounts: {
          [s.accountId]: {
            name: s.username,
            // A mailbox shared with the person (ADR-0026) is not their own.
            isPersonal: s.delegated === undefined,
            isReadOnly: false,
            accountCapabilities: { "urn:ietf:params:jmap:mail": {} },
          },
        },
        primaryAccounts: { "urn:ietf:params:jmap:core": s.accountId, "urn:ietf:params:jmap:mail": s.accountId },
        username: s.username,
        apiUrl: "/api/webmail/jmap",
        downloadUrl: "/api/webmail/download/{blobId}",
        uploadUrl: "",
        eventSourceUrl: "",
        state: "0",
      });
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
