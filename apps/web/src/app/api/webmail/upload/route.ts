// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { WEBMAIL_ATTACHMENTS } from "@anhourmail/shared";

import { ok, route } from "@/server/http/route";
import { MAX_UPLOAD_BYTES, uploadType } from "@/server/webmail/compose";
import {
  BodyTooLargeError,
  handleWebmail,
  noAccount,
  readCappedBytes,
  shownAccount,
  unauthorized,
  withUploadSlot,
} from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * Uploads one attachment (raw body, its type in Content-Type) to the active mailbox, capped at 20 MB, and returns
 * its blob id for a draft. The type is reduced to a plain MIME token pair; nothing is rendered from it.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    // The mailbox this tab shows: refused (400) if another tab switched the session to a different mailbox.
    const account = shownAccount(req);
    if (!account) return noAccount();
    return withUploadSlot(async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await readCappedBytes(req, MAX_UPLOAD_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return NextResponse.json(
            {
              error: {
                code: "too_large",
                message: `Attachments can be up to ${String(WEBMAIL_ATTACHMENTS.perFileMb)} MB each.`,
              },
            },
            { status: 413 },
          );
        }
        throw err;
      }
      if (bytes.length === 0) {
        return NextResponse.json({ error: { code: "bad_request", message: "That file is empty." } }, { status: 400 });
      }
      return handleWebmail(async () =>
        ok(await webmail().upload(id, bytes, uploadType(req.headers.get("content-type")), account), 201),
      );
    });
  },
  { session: "webmail", limit: "webmailUpload" },
);
