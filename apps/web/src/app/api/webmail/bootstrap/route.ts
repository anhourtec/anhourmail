// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { ok, route } from "@/server/http/route";
import {
  BootstrapUnavailableError,
  firstLoad,
  MailboxChangedError,
  parseBootstrapQuery,
} from "@/server/webmail/bootstrap";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * The webmail's first load in one round trip (`server/webmail/bootstrap.ts`): the JMAP session document, folders,
 * sync states, the Priority count and the opened view's first window. `?start=inbox|priority|folder:<id>`,
 * `grouping=conversations|messages`, `chips=0|1` (the person's preferences, which the page already has), and on a
 * mailbox-scoped tab `folder=<role|id>`; `expect=<address>`, the mailbox the app shows (another active one → 409
 * `mailbox_changed`). Reads the active mailbox — or the tab's pinned shared one, whose grant the
 * gate checks now — with the session's own token through the same queue as the JMAP proxy; nothing is written.
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const input = parseBootstrapQuery(new URL(req.url).searchParams);
    if (!input) return badRequest("Reload the page and try again.");
    return handleWebmail(async () => {
      try {
        const b = await firstLoad(webmail(), id, input);
        return b ? ok(b) : unauthorized();
      } catch (err) {
        if (err instanceof MailboxChangedError) {
          return NextResponse.json(
            { error: { code: "mailbox_changed", message: "Your active mailbox changed. Reload the page." } },
            { status: 409 },
          );
        }
        if (!(err instanceof BootstrapUnavailableError)) throw err;
        return NextResponse.json(
          { error: { code: "unavailable", message: "The mail server isn't answering. Try again in a moment." } },
          { status: 503 },
        );
      }
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
