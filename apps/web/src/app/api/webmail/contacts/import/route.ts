// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { recordContactsImport } from "@anhourmail/core/data";

import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { MAX_IMPORT_BYTES } from "@/server/webmail/contacts";
import { CONTACTS_FILE_TOO_LARGE, decodeColumns } from "@/server/webmail/contacts-csv";
import {
  BodyTooLargeError,
  handleWebmail,
  noAccount,
  readCappedBytes,
  shownAccount,
  unauthorized,
} from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import type { ContactsImportFile } from "@/server/webmail/service";

const badRequest = (message: string) => NextResponse.json({ error: { code: "bad_request", message } }, { status: 400 });

/**
 * Imports a contacts file into My contacts (ADR-0030 §10): the raw body is the file, up to `IMPORT.contactsMaxBytes`
 * and `IMPORT.contactsMaxCards` contacts. `?format=vcard` (the default) or `?format=csv&columns=<field>,,<field>…`
 * with one entry per column (a card field, or empty for "Don't import"). The BFF parses the whole file itself and
 * merges by email; the answer is `{ format, created, merged, duplicates, invalid, overCap }`. The session's own mailbox
 * only (a shared one is 403), pinned to the account the tab shows. Audited `data.contacts_imported` (format and counts).
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const params = new URL(req.url).searchParams;
    const format = params.get("format") ?? "vcard";
    if (format !== "vcard" && format !== "csv") return badRequest("Choose a .vcf or .csv file.");
    let columns: ReturnType<typeof decodeColumns> = null;
    if (format === "csv") {
      columns = decodeColumns(params.get("columns"));
      if (!columns) return badRequest("Choose what each column holds, or Don't import.");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(req, MAX_IMPORT_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json({ error: { code: "too_large", message: CONTACTS_FILE_TOO_LARGE } }, { status: 413 });
      }
      throw err;
    }
    const file: ContactsImportFile = columns ? { format: "csv", bytes, columns } : { format: "vcard", bytes };
    return handleWebmail(async () => {
      const counts = await webmail().importContacts(id, account, file, (address, c) =>
        recordContactsImport(container().deps, address, { format: file.format, ...c }, meta),
      );
      return ok({ format: file.format, ...counts });
    });
  },
  { session: "webmail", limit: "webmailUpload" },
);
