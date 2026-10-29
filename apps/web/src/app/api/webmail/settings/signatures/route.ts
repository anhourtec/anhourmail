// SPDX-License-Identifier: AGPL-3.0-only
import { ok, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { readSignatureBody } from "@/server/webmail/signature-body";

/**
 * The active mailbox's signatures and its two defaults (docs/internal/05-webmail.md "Signatures"). The first read
 * brings over the signature its addresses had from before named signatures, once.
 */
export const GET = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => ok(await webmailSettings().signatures(id, meta)));
  },
  { session: "webmail", limit: "webmailSettings" },
);

/** Adds a signature (name + HTML, sanitised and capped by the BFF; embedded images only). */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const body = await readSignatureBody(req);
    if (!body.ok) return body.res;
    if (body.input.name === undefined) return badRequest("Give the signature a name.");
    const input = body.input;
    return handleWebmail(async () => ok(await webmailSettings().createSignature(id, account, input, meta)));
  },
  { session: "webmail", limit: "write" },
);
