// SPDX-License-Identifier: AGPL-3.0-only
import { removeWebmailAvatar, setWebmailAvatar } from "@anhourmail/core/avatars";

import { avatarImages, avatarUrl, withAvatarUpload } from "@/server/avatars";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { ownMailbox } from "@/server/webmail/service";

/**
 * Settings → Account → You: the photo of the active mailbox's person (the same photo as their console Profile page),
 * or of the mailbox itself when it has no person (ADR-0022). POST takes the raw image (PNG, JPEG or WebP, capped);
 * DELETE removes it. Audited like the console's change, as made from the webmail.
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      // A live session before the body is read (see withAvatarUpload); the person's own mailbox only, decided on this
      // read, so switching to a shared one while the body streams changes nothing (ADR-0026 §6).
      const s = ownMailbox(await webmail().session(id));
      return withAvatarUpload(req, async (bytes) => {
        const ref = await setWebmailAvatar(container().deps, avatarImages(), s.username, bytes, meta);
        return ok({ url: avatarUrl("/api/webmail/avatars", ref) });
      });
    });
  },
  { session: "webmail", limit: "avatarUpload" },
);

export const DELETE = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      const s = ownMailbox(await webmail().session(id));
      await removeWebmailAvatar(container().deps, s.username, meta);
      return ok({ url: null });
    });
  },
  { session: "webmail", limit: "write" },
);
