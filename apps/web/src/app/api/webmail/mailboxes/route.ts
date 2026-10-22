// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { failuresExceeded, LIMITS, recordFailure } from "@anhourmail/server/rate-limit";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailFailures, webmailSessionId } from "@/server/webmail/instance";
import { WebmailSignInError } from "@/server/webmail/service";

/** The mailboxes signed in to this webmail session, the active one first. */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      const m = await webmail().mailboxes(id);
      return m ? ok(m) : unauthorized();
    });
  },
  { session: "webmail", limit: "webmail" },
);

const Add = z.object({ address: z.email().max(254), password: z.string().min(1).max(1024) });

/**
 * "Add another mailbox": signs a second (third…) mailbox in to this session with its own address and password,
 * and makes it active. Same limits and generic errors as the first sign-in.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = Add.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Enter the mailbox address and password.");
    const address = parsed.data.address.trim().toLowerCase();
    const subject = `a:${createHash("sha256").update(address).digest("base64url").slice(0, 22)}`;
    const failures = webmailFailures();
    if (await failuresExceeded(failures, "webmailSignInAddress", LIMITS.webmailSignInAddress, subject)) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again." } },
        { status: 429 },
      );
    }
    return handleWebmail(async () => {
      try {
        const s = await webmail().addMailbox(id, address, parsed.data.password);
        return ok({ active: s.username, others: (s.others ?? []).map((m) => m.username) });
      } catch (err) {
        if (err instanceof WebmailSignInError) {
          await recordFailure(failures, "webmailSignInAddress", LIMITS.webmailSignInAddress, subject);
        }
        throw err;
      }
    });
  },
  { session: "webmail", limit: "webmailSignIn" },
);
