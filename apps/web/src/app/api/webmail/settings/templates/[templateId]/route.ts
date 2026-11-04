// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, notFound, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { readTemplateBody } from "@/server/webmail/template-body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Renames and/or rewrites one of the active mailbox's templates; another mailbox's id is a 404. */
export const PATCH = route(
  async ({ req, meta }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const templateId = typeof params.templateId === "string" ? params.templateId : "";
    if (!UUID.test(templateId)) return notFound();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const body = await readTemplateBody(req, id);
    if (!body.ok) return body.res;
    if (body.input.name === undefined && body.input.html === undefined) return badRequest("Nothing to change.");
    const input = body.input;
    return handleWebmail(async () => ok(await webmailSettings().updateTemplate(id, account, templateId, input, meta)));
  },
  { session: "webmail", limit: "write" },
);

/** Deletes one of the active mailbox's templates. */
export const DELETE = route(
  async ({ req, meta }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const templateId = typeof params.templateId === "string" ? params.templateId : "";
    if (!UUID.test(templateId)) return notFound();
    const account = shownAccount(req);
    if (!account) return noAccount();
    return handleWebmail(async () => ok(await webmailSettings().removeTemplate(id, account, templateId, meta)));
  },
  { session: "webmail", limit: "write" },
);
