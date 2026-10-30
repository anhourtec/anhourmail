// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { log } from "@anhourmail/server/log";

import { DELEGATION_REFUSED, OWN_MAILBOX_ONLY, webmailErrorResponse } from "./http";
import { webmail, webmailSessionId } from "./instance";
import { REFUSED_HEADER } from "./pin";
import type { WebmailSession } from "./session-store";

/**
 * The delegation gate on the webmail API (ADR-0026 §6, "The gate on every request"). `route()` calls it for every
 * route with `session: "webmail"` once the access check has passed, so no webmail route, present or future, acts on a
 * mailbox shared with the person without the grant being checked now:
 *
 * - routes that read and manage the active mailbox opt in with `delegated: "full_access"` (the JMAP proxy, message
 *   views, downloads, the image proxy…): with a delegated active entry, the grant is checked (core `DelegationGate`,
 *   "has the right" cached ≤ 10 s, "no right" never); refused → the entry is dropped and the answer is 404;
 * - routes that work whichever mailbox is active say `delegated: "allowed"` (listing, switching and opening
 *   mailboxes, signing out, adding one's own mailbox); the service's own check still covers any use of the entry;
 * - every other webmail route (sending, drafts, uploads, identities, settings, contacts, export) answers 403
 *   `own_mailbox_only` while a delegated mailbox is active: those always need the person's own mailbox.
 *
 * This is defence in depth: the request reads the session again later, so the service decides on the entry whose
 * token it actually uses (`WebmailService`: delegated tokens only on its read paths; `ownMailbox` for the settings,
 * password, photo and export callers). A switch between this check and the handler can't aim an own-only action at
 * a shared mailbox.
 *
 * Sessions without a delegated active entry pass untouched. A pin test lists the routes of each kind.
 */

export type DelegationMode = "full_access" | "allowed";

export type DelegationGateDeps = {
  /** The session record (no refresh, no mail server call), or null when signed out. */
  session: (sessionId: string) => Promise<WebmailSession | null>;
  /** Whether its delegated active entry may still be used (core gate, cached ≤ 10 s). Throws when it can't tell. */
  allowed: (sessionId: string, s: WebmailSession) => Promise<boolean>;
  /** Drops that entry (the session goes on with the person's own mailbox). */
  drop: (sessionId: string, username: string) => Promise<void>;
};

const defaults = (): DelegationGateDeps => ({
  session: (id) => webmail().store.read(id),
  allowed: (id, s) => webmail().delegatedActiveAllowed(id, s),
  drop: async (id, username) => {
    await webmail().dropDelegated(id, new Set([username]));
  },
});

const answer = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status });

/** The refusal for this request, or null when it may go on. Signed-out requests go on: the route answers 401. */
export async function delegationBlock(
  req: Request,
  mode: DelegationMode | undefined,
  deps: DelegationGateDeps = defaults(),
): Promise<Response | null> {
  const id = webmailSessionId(req.headers.get("cookie"));
  if (!id) return null;
  const s = await deps.session(id);
  if (!s?.delegated || mode === "allowed") return null;
  if (mode === undefined) return answer("own_mailbox_only", OWN_MAILBOX_ONLY, 403);
  let ok: boolean;
  try {
    ok = await deps.allowed(id, s);
  } catch (err) {
    // The person's own sign-in no longer holds at the mail server: the whole session ended (401, cookie cleared).
    const mapped = webmailErrorResponse(err);
    if (mapped?.status === 401) return mapped;
    log.warn("webmail: delegation gate unavailable", { component: "webmail", err });
    return answer("unavailable", "The mail server isn't answering. Try again in a moment.", 503);
  }
  if (ok) return null;
  await deps.drop(id, s.username).catch((err: unknown) => {
    log.warn("webmail: delegated entry not dropped", { component: "webmail", err });
  });
  const refused = answer("not_found", DELEGATION_REFUSED, 404);
  refused.headers.set(REFUSED_HEADER, "mailbox");
  return refused;
}
