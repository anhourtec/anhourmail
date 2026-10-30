// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { avatarPath, MAX_AVATAR_LOOKUP, webmailAvatarLookup } from "@anhourmail/core/avatars";

import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { badRequest, BodyTooLargeError, handleWebmail, readCappedText, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Body = z.object({ addresses: z.array(z.string().max(320)).max(MAX_AVATAR_LOOKUP) });

/**
 * Photos for addresses the webmail is showing (senders of loaded messages, contacts): `{ addresses }` →
 * `{ avatars: { address: url } }`, only for mailboxes in the same account as one of this session's mailboxes (the
 * service filters), so it says nothing about other accounts. A POST so the addresses never reach an access log.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    let parsed;
    try {
      parsed = Body.safeParse(JSON.parse(await readCappedText(req, 64 * 1024)) as unknown);
    } catch (err) {
      if (!(err instanceof BodyTooLargeError || err instanceof SyntaxError)) throw err;
      parsed = null;
    }
    if (!parsed?.success) return badRequest(`Send up to ${String(MAX_AVATAR_LOOKUP)} addresses.`);
    const addresses = parsed.data.addresses;
    return handleWebmail(async () => {
      const m = await webmail().mailboxes(id);
      if (!m) return unauthorized();
      const refs = await webmailAvatarLookup(container().deps, [m.active, ...m.others], addresses);
      return ok({
        avatars: Object.fromEntries(
          Object.entries(refs).map(([address, ref]) => [address, avatarPath("/api/webmail/avatars", ref)]),
        ),
      });
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
