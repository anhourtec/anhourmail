// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, noAccount, shownAccount, unauthorized } from "@/server/webmail/http";
import { webmailSessionId, webmailSettings } from "@/server/webmail/instance";

/**
 * Forwarding (docs/internal/05-webmail.md "Settings"). POST asks the target's owner to confirm (emails a one-time
 * link; fail-closed tier plus a per-mailbox daily cap); PUT turns forwarding to the confirmed target on or off;
 * DELETE stops it and forgets the target. All audited.
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const body = (await readJson(req)) as { address?: unknown } | null;
    return handleWebmail(async () =>
      ok(await webmailSettings().requestForwarding(id, account, body?.address, meta), 201),
    );
  },
  { session: "webmail", limit: "forwardingVerify" },
);

const Toggle = z.object({ enabled: z.boolean(), keepCopy: z.boolean() });

export const PUT = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    const parsed = Toggle.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Choose on or off, and whether to keep a copy.");
    return handleWebmail(async () => ok(await webmailSettings().setForwarding(id, account, parsed.data, meta)));
  },
  { session: "webmail", limit: "write" },
);

export const DELETE = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const account = shownAccount(req);
    if (!account) return noAccount();
    return handleWebmail(async () => {
      await webmailSettings().removeForwarding(id, account, meta);
      return ok({ removed: true });
    });
  },
  { session: "webmail", limit: "write" },
);
