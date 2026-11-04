// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { ok, route } from "@/server/http/route";
import {
  BodyTooLargeError,
  badRequest,
  handleWebmail,
  noAccount,
  readCappedText,
  shownAccount,
  unauthorized,
} from "@/server/webmail/http";
import { webmail, webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { RulesChange } from "@/server/webmail/settings";

/** Largest rules body: 50 rules of 5 conditions of 200 characters, JSON-escaped, with room to spare. */
const MAX_RULES_BODY = 256 * 1024;

/** The mailbox's mail rules (ADR-0032 §2): the list, its version, the folders and the forwarding address. */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmailSettings().rules(id)));
  },
  { session: "webmail", limit: "webmailSettings" },
);

/**
 * Saves the whole ordered list against the version read (409 when it changed), compiled into the managed Sieve script
 * (`sieve.changed`). The session's own mailbox only.
 */
export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    // The body is read only for a signed-in session (a random cookie can't make the server buffer it).
    if (!(await webmail().session(id))) return unauthorized();
    let json: unknown;
    try {
      json = JSON.parse(await readCappedText(req, MAX_RULES_BODY));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json(
          { error: { code: "too_large", message: "These rules are too long to save." } },
          { status: 413 },
        );
      }
      return badRequest("Request body must be JSON.");
    }
    const parsed = RulesChange.safeParse(json);
    if (!parsed.success) return badRequest("These rules can't be saved.");
    return handleWebmail(async () => ok(await webmailSettings().saveRules(id, account, parsed.data, meta)));
  },
  { session: "webmail", limit: "write" },
);
