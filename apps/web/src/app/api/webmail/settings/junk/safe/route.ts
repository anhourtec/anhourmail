// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route, type RouteContext } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";
import { type SafeSenderChange, SafeSenderInput } from "@/server/webmail/settings";

/**
 * "Always for <sender>" (`POST`) and "Stop loading" (`DELETE`) from a message (ADR-0027 §4): `{ emailId }`, never an
 * address — the server reads that message's From with the session's token and re-checks it is verified, then adds the
 * address to Safe senders or removes the entry it matched (managed Sieve script; `junk_rules.changed`, counts and
 * kinds only). Own mailbox only: in a tab of a mailbox shared with the person the gate answers 403 and the refusal is
 * audited. 404: a message this session can't see; 400: unverified From, list full, wrong account pin; 409: the
 * address is blocked, or the settings changed meanwhile.
 */
async function changeFrom({ req, meta }: RouteContext, change: SafeSenderChange): Promise<Response> {
  const id = webmailSessionId(req.headers.get("cookie"));
  if (!id) return unauthorized();
  const account = shownAccount(req);
  if (!account) return noAccount();
  const parsed = SafeSenderInput.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Say which message.");
  return handleWebmail(async () =>
    ok(await webmailSettings().changeSafeSender(id, account, parsed.data.emailId, change, meta)),
  );
}

/** Audits the gate's refusal in a shared mailbox's tab (the person as actor; ADR-0027 §7). */
const refused = async ({ req, meta }: RouteContext) => {
  const id = webmailSessionId(req.headers.get("cookie"));
  if (id) await webmailSettings().refusedInSharedMailbox(id, meta);
};

/** "Always for <sender>": adds the message's From address. */
export const POST = route(
  async (ctx) => {
    return changeFrom(ctx, "add");
  },
  { session: "webmail", limit: "write", onSharedRefusal: refused },
);

/** "Stop loading": removes whichever entry the message's From matched (its address, or its domain). */
export const DELETE = route(
  async (ctx) => {
    return changeFrom(ctx, "remove");
  },
  { session: "webmail", limit: "write", onSharedRefusal: refused },
);
