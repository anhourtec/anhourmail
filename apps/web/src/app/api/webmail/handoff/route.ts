// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";
import { z } from "zod";

import { DomainError } from "@anhourmail/core";
import { handoffChallenge, newHandoffVerifier, redeemWebmailHandoff } from "@anhourmail/core/webmail";
import { CONSOLE_HANDOFF_PAGE } from "@anhourmail/shared/webmail";

import { container } from "@/server/container";
import { env } from "@/server/env";
import { domainErrorResponse, ok, readJson, route } from "@/server/http/route";
import { handoffAccess, handoffCookie, handoffVerifier, redisHandoffCodes } from "@/server/webmail/handoff";
import { webmailErrorResponse } from "@/server/webmail/http";
import { webmail, webmailCookie, webmailSessionId } from "@/server/webmail/instance";
import { knownTag, knownTags, rememberKnown } from "@/server/webmail/known-mailboxes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Console → webmail handoff, step 1 (ADR-0024), on the webmail origin: the console's **Open webmail** link lands here.
 * Sets a fresh verifier in this browser's cookie (HttpOnly, SameSite=Strict, two minutes) and sends the browser to the
 * console with only its SHA-256, so the code the console mints can be redeemed in this browser alone. `?mailbox=` (a
 * mailbox id, never an address) pre-selects one on the console page. Nothing here is a credential.
 */
export const GET = route(
  async ({ req }) => {
    const verifier = newHandoffVerifier();
    const mailbox = new URL(req.url).searchParams.get("mailbox");
    const to = new URL(CONSOLE_HANDOFF_PAGE, env().APP_URL);
    to.searchParams.set("challenge", handoffChallenge(verifier));
    if (mailbox && UUID.test(mailbox)) to.searchParams.set("mailbox", mailbox.toLowerCase());
    const res = new NextResponse(null, { status: 303, headers: { Location: to.toString() } });
    res.headers.append("Set-Cookie", handoffCookie(verifier));
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  },
  { limit: "webmailHandoffIp" },
);

const Redeem = z.object({ code: z.string().max(64) });

/**
 * Step 3: redeems the code from the console with this browser's verifier and opens an ordinary webmail session for
 * the person's own mailbox (a throwaway mail-server credential is minted, used once and destroyed). The verifier
 * cookie is cleared whatever happens. 400 `handoff_invalid` for an unknown, used or expired code; 409
 * `handoff_refused` (with what to do) when something changed; 403 while acting as someone.
 */
export const POST = route(
  async ({ req, meta }) => {
    const cookies = req.headers.get("cookie");
    const parsed = Redeem.safeParse(await readJson(req));
    let res: Response;
    // The webmail session the redemption made, until its audit entry has committed: dropped again if anything after
    // it fails, so no session exists that the audit log doesn't show.
    let made: string | null = null;
    try {
      const { sessionId, session } = await redeemWebmailHandoff(
        container().deps,
        redisHandoffCodes(),
        handoffAccess(),
        { code: parsed.success ? parsed.data.code : null, verifier: handoffVerifier(cookies) },
        async (target) => {
          const opened = await webmail().openHandoff(target);
          made = opened.sessionId;
          return opened;
        },
        meta,
      );
      made = null;
      // A webmail session this browser already had is replaced, not left behind in Redis.
      const previous = webmailSessionId(cookies);
      if (previous) await webmail().signOut(previous);
      const e = env();
      res = ok({ username: session.username });
      res.headers.append("Set-Cookie", webmailCookie(sessionId, webmail().store.cookieMaxAgeSec));
      res.headers.append(
        "Set-Cookie",
        rememberKnown(
          knownTags(cookies),
          knownTag(e.BETTER_AUTH_SECRET, session.username),
          e.WEBMAIL_URL.startsWith("https://"),
        ),
      );
    } catch (err) {
      const orphan = made as string | null;
      if (orphan) await webmail().signOut(orphan);
      const mapped = err instanceof DomainError ? domainErrorResponse(err) : webmailErrorResponse(err);
      if (!mapped) throw err;
      res = mapped;
    }
    res.headers.append("Set-Cookie", handoffCookie(null));
    return res;
  },
  { limit: "webmailHandoffIp" },
);
