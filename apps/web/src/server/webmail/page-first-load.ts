// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { log } from "@anhourmail/server/log";
import { callerKey, checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";

import { container } from "../container";
import { type Bootstrap, type BootstrapInput, firstLoad } from "./bootstrap";
import { webmail } from "./instance";
import { withSessionReads } from "./session-store";

/**
 * The first load for the webmail page itself (`app/webmail/page.tsx`): the same answer as `GET /api/webmail/bootstrap`,
 * started on the server while the page renders and streamed to the browser inside the page, so the inbox needs no
 * round trip of its own after the app's code has loaded (docs/internal/05-webmail.md "First load"). Only for the
 * person's own active mailbox, after the page has checked the session (access, console session, the first-sign-in
 * password step, a shared mailbox handed back). It counts against the same per-session budget as the route; over it,
 * or on any failure, it resolves to null and the app asks the route instead. Never rejects.
 */
export function pageFirstLoad(
  sessionId: string,
  ip: string | null,
  /** The mailbox the page shows: an answer for any other (the session changed meanwhile) is dropped. */
  address: string,
  input: BootstrapInput,
): Promise<Bootstrap | null> {
  return (async () => {
    try {
      const rl = await checkRateLimit(
        container().counter,
        "webmail:GET /api/webmail/bootstrap",
        LIMITS.webmail,
        callerKey(sessionId, ip),
      );
      if (!rl.allowed) return null;
      return await withSessionReads(() =>
        firstLoad(webmail(), sessionId, { ...input, expect: address.trim().toLowerCase() }),
      );
    } catch (err) {
      log.warn("webmail: first load not included in the page", { component: "webmail", err });
      return null;
    }
  })();
}
