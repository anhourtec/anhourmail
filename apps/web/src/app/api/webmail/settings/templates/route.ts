// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { readTemplateBody } from "@/server/webmail/template-body";

/** The active mailbox's templates (canned replies, ADR-0032 §3). */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmailSettings().templates(id)));
  },
  { session: "webmail", limit: "webmailSettings" },
);

/** Adds a template (`{ name, html }`; sanitised, no images). Audited `webmail.template_added`. */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const body = await readTemplateBody(req, id);
    if (!body.ok) return body.res;
    const input = body.input;
    return handleWebmail(async () => ok(await webmailSettings().createTemplate(id, account, input, meta), 201));
  },
  { session: "webmail", limit: "write" },
);
