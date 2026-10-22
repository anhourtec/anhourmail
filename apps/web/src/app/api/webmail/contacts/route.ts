// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { ContactInput, hasIdentity } from "@/server/webmail/contacts";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const jmapId = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

/**
 * The active mailbox's contacts (Stalwart address books over JMAP Contacts; never stored by us), its address books,
 * and whether people you email are saved automatically.
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmail().contacts(id)));
  },
  { session: "webmail", limit: "webmailContacts" },
);

const Create = z.object({ contact: ContactInput, book: z.enum(["mine", "other"]).default("mine") });

/** Adds a contact (built by the BFF from the validated fields) to My contacts or Other contacts. */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Create.safeParse(await readJson(req));
    if (!parsed.success || !hasIdentity(parsed.data.contact)) return badRequest("Add a name, an address or a phone.");
    return handleWebmail(async () =>
      ok(await webmail().createContact(id, account, parsed.data.contact, parsed.data.book), 201),
    );
  },
  { session: "webmail", limit: "write" },
);

const Delete = z.object({ ids: z.array(jmapId).min(1).max(500) });

/** Deletes contacts (the app asks for confirmation first). */
export const DELETE = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Delete.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose contacts to delete.");
    return handleWebmail(async () => ok({ deleted: await webmail().deleteContacts(id, account, parsed.data.ids) }));
  },
  { session: "webmail", limit: "write" },
);
