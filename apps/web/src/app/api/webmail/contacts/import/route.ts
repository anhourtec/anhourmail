// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { ok, route } from "@/server/http/route";
import { MAX_IMPORT_BYTES } from "@/server/webmail/contacts";
import {
  BodyTooLargeError,
  handleWebmail,
  noAccount,
  readCappedText,
  shownAccount,
  unauthorized,
} from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/** Imports a .vcf file (raw body, up to 1 MB and 1,000 contacts) into My contacts; parsed and capped by the BFF. */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    let text: string;
    try {
      text = await readCappedText(req, MAX_IMPORT_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json(
          { error: { code: "too_large", message: "Contact files can be up to 1 MB." } },
          { status: 413 },
        );
      }
      throw err;
    }
    return handleWebmail(async () => ok(await webmail().importContacts(id, account, text)));
  },
  { session: "webmail", limit: "webmailUpload" },
);
