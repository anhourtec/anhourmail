// SPDX-License-Identifier: AGPL-3.0-only
import type { JmapSession } from "@anhourmail/jmap-client";

import { MAX_CALLS, MAX_REQUEST_BYTES } from "./jmap-policy";

/**
 * The JMAP Session resource (RFC 8620 §2) as the browser sees it (`GET /api/webmail/session`, and the first load's
 * `session`): URLs point at this origin's proxy; Stalwart's real URLs and the token never reach the browser.
 */
export function jmapSessionDocument(s: {
  accountId: string;
  username: string;
  delegated?: unknown;
}): JmapSession & { accounts: Record<string, unknown> } {
  return {
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
  };
}
