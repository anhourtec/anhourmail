// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { failuresExceeded, LIMITS, recordFailure } from "@anhourmail/server/rate-limit";

import { env } from "@/server/env";
import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail } from "@/server/webmail/http";
import { webmail, webmailCookie, webmailFailures, webmailSessionId } from "@/server/webmail/instance";
import { hasKnownTag, knownTag, knownTags, rememberKnown } from "@/server/webmail/known-mailboxes";
import { WebmailBlockedError, WebmailSignInError } from "@/server/webmail/service";

const SignIn = z.object({
  address: z.email().max(254),
  password: z.string().min(1).max(1024),
});

/**
 * Webmail sign-in (ADR-0018): mailbox address + mailbox password → Stalwart OAuth tokens kept server-side, and an
 * opaque HttpOnly session cookie for this origin. The password is used once and never stored or logged. Limited
 * per IP (every attempt, fail closed, `webmailSignIn`) and per address (wrong passwords only, fail closed,
 * `webmailSignInAddress`); every wrong password gets the same answer. The one exception: Stalwart refuses a suspended
 * mailbox's right password like a wrong one, so when this browser has signed in to the address before
 * (`known-mailboxes`), a refusal for a mailbox the control plane blocks says why instead (07-security.md "Webmail
 * sign-in and suspension").
 */
export const POST = route(
  async ({ req }) => {
    const parsed = SignIn.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Enter your mailbox address and password.");
    const address = parsed.data.address.trim().toLowerCase();
    // Wrong passwords per address (successes don't count, so nobody can lock a person out by signing in as them).
    const subject = `a:${createHash("sha256").update(address).digest("base64url").slice(0, 22)}`;
    const failures = webmailFailures();
    if (await failuresExceeded(failures, "webmailSignInAddress", LIMITS.webmailSignInAddress, subject)) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again." } },
        { status: 429 },
      );
    }
    const e = env();
    const known = knownTags(req.headers.get("cookie"));
    const tag = knownTag(e.BETTER_AUTH_SECRET, address);
    return handleWebmail(async () => {
      try {
        const { sessionId, session } = await webmail().signIn(address, parsed.data.password);
        const res = ok({ username: session.username });
        res.headers.append("Set-Cookie", webmailCookie(sessionId, webmail().store.cookieMaxAgeSec));
        res.headers.append("Set-Cookie", rememberKnown(known, tag, e.WEBMAIL_URL.startsWith("https://")));
        return res;
      } catch (err) {
        if (err instanceof WebmailSignInError) {
          await recordFailure(failures, "webmailSignInAddress", LIMITS.webmailSignInAddress, subject);
          // Only a browser that signed in to this address before learns it is blocked; anyone else can't tell.
          if (hasKnownTag(known, tag)) {
            const reason = await webmail().blockedReason(address);
            if (reason) throw new WebmailBlockedError("mailbox unavailable", reason);
          }
        }
        throw err;
      }
    });
  },
  { limit: "webmailSignIn" },
);

/** Sign out: drops the session (and its tokens) and clears the cookie. Always succeeds. */
export const DELETE = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (id) await webmail().signOut(id);
    const res = ok({ signedOut: true });
    res.headers.append("Set-Cookie", webmailCookie("", 0));
    return res;
  },
  { session: "webmail", passwordChange: "allowed", delegated: "allowed" },
);
