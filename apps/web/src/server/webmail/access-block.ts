// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { WebmailAccess } from "@anhourmail/core/webmail";

import { webmailErrorResponse } from "./http";
import { mailboxAccessGate, webmail, webmailSessionId } from "./instance";
import { WebmailBlockedError } from "./service";

/**
 * The control-plane access check on the webmail API (docs/internal/05-webmail.md "Session acquisition"). `route()`
 * calls it before the handler of every route with `session: "webmail"` — before the first-sign-in password gate — so
 * no webmail route, present or future, serves a session whose mailbox is suspended, being deleted or gone, or whose
 * person staff suspended, even one that never reaches the mail server (settings, contacts preferences). A blocked
 * session is ended (its record deleted, the cookie cleared) and answered 401 `mailbox_unavailable` with the reason's
 * message. The BFF's own per-use check (`WebmailService.session`) stays as the second line.
 */

export type AccessBlockDeps = {
  /** The active mailbox of this webmail session (no refresh, no mail server call), or null when signed out. */
  username: (sessionId: string) => Promise<string | null>;
  state: (address: string) => Promise<WebmailAccess>;
  /** Ends the session (drops its record and tokens). */
  end: (sessionId: string) => Promise<void>;
};

const defaults = (): AccessBlockDeps => ({
  username: async (id) => (await webmail().store.read(id))?.username ?? null,
  state: (address) => mailboxAccessGate().state(address),
  end: (id) => webmail().signOut(id),
});

/** The refusal for this request, or null when it may go on. Signed-out requests go on: the route answers 401. */
export async function mailboxAccessBlock(req: Request, deps: AccessBlockDeps = defaults()): Promise<Response | null> {
  const id = webmailSessionId(req.headers.get("cookie"));
  if (!id) return null;
  const address = await deps.username(id);
  if (!address) return null;
  const access = await deps.state(address);
  if (access === "ok") return null;
  await deps.end(id);
  return webmailErrorResponse(new WebmailBlockedError("mailbox unavailable", access));
}
