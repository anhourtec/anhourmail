// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { ContactInput, hasIdentity } from "@/server/webmail/contacts";
import { badRequest, handleWebmail, noAccount, notFound, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId } from "@/server/webmail/view";

/** Changes a contact's name, addresses, phones, organisation, notes, birthday and labels (other card data stays). */
export const PATCH = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const contactId = typeof params.contactId === "string" ? params.contactId : "";
    if (!isJmapId(contactId)) return notFound();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = ContactInput.safeParse(await readJson(req));
    if (!parsed.success || !hasIdentity(parsed.data)) return badRequest("Add a name, an address or a phone.");
    return handleWebmail(async () => {
      await webmail().updateContact(id, account, contactId, parsed.data);
      return ok({ id: contactId });
    });
  },
  { session: "webmail", limit: "write" },
);
