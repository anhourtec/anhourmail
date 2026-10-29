// SPDX-License-Identifier: AGPL-3.0-only
import { webmailAvatarImage } from "@anhourmail/core/avatars";

import { container } from "@/server/container";
import { avatarOwnerParam, avatarResponse } from "@/server/avatars";
import { route } from "@/server/http/route";
import { handleWebmail, notFound, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * A profile photo on the webmail origin: only people and mailboxes in the accounts of this session's mailboxes
 * (404 for anything else). Same headers as the console's: a re-encoded WebP, `nosniff`, a sandboxing CSP, cached
 * privately under the version in the URL.
 */
export const GET = route(
  async ({ req }, params) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const owner = avatarOwnerParam(params);
    if (!owner) return notFound();
    return handleWebmail(async () => {
      const m = await webmail().mailboxes(id);
      if (!m) return unauthorized();
      return avatarResponse(await webmailAvatarImage(container().deps, [m.active, ...m.others], owner), req);
    });
  },
  { session: "webmail", limit: "webmail", cache: "handler" },
);
