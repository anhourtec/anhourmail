// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { passwordChangeGate, webmail, webmailSessionId } from "./instance";

/**
 * The first-sign-in password change on the webmail API (docs/internal/07-security.md "Mailbox passwords"). The page
 * shows the password step instead of the inbox; this makes the API agree: while the session's active mailbox must
 * change its password, every webmail route answers 403 `password_change_required`, except the routes that opt in
 * with `passwordChange: "allowed"` (changing the password and signing out). `route()` calls it for every route with
 * `session: "webmail"`, so a new webmail route is blocked unless it says otherwise.
 */

export const PASSWORD_CHANGE_REQUIRED = "password_change_required";

export type PasswordGateDeps = {
  /** The active mailbox of this webmail session (no refresh, no mail server call), or null when signed out. */
  username: (sessionId: string) => Promise<string | null>;
  required: (address: string) => Promise<boolean>;
};

const defaults = (): PasswordGateDeps => ({
  username: async (id) => (await webmail().store.read(id))?.username ?? null,
  required: (address) => passwordChangeGate().required(address),
});

/**
 * The refusal for this request, or null when it may go on. Signed-out requests go on: the route itself answers 401.
 */
export async function passwordChangeBlock(req: Request, deps: PasswordGateDeps = defaults()): Promise<Response | null> {
  const id = webmailSessionId(req.headers.get("cookie"));
  if (!id) return null;
  const address = await deps.username(id);
  if (!address || !(await deps.required(address))) return null;
  return NextResponse.json(
    {
      error: {
        code: PASSWORD_CHANGE_REQUIRED,
        message: "Choose your own password first. Reload the page to continue.",
      },
    },
    { status: 403 },
  );
}
