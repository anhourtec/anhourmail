// SPDX-License-Identifier: AGPL-3.0-only
import { avatarPath, webmailOwnAvatars } from "@anhourmail/core/avatars";

import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

/**
 * The photo shown for each mailbox signed in to this session (the sidebar's mailbox tiles and header, the account
 * switcher): its person's photo — the same one as the console — or, for a mailbox without a person, its own.
 * `{ mailboxes: [{ address, url, own, editable }] }`, `url` null when there is none; `own` tells which one Settings
 * changes, `editable` whether it may here (a person in more than one account changes theirs in the console).
 */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      const m = await webmail().mailboxes(id);
      if (!m) return unauthorized();
      const list = await webmailOwnAvatars(container().deps, [m.active, ...m.others]);
      return ok({
        mailboxes: list.map((a) => ({
          address: a.address,
          url: a.ref ? avatarPath("/api/webmail/avatars", a.ref) : null,
          own: a.owner?.kind ?? "person",
          editable: a.editable,
        })),
      });
    });
  },
  { session: "webmail", limit: "webmail", delegated: "full_access" },
);
