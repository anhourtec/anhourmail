// SPDX-License-Identifier: AGPL-3.0-only
import { ownAvatar, removeOwnAvatar, setOwnAvatar } from "@anhourmail/core/avatars";

import { UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { avatarImages, avatarUrl, withAvatarUpload } from "@/server/avatars";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

/**
 * The signed-in person's own profile photo (ADR-0022). GET: its URL (or null), so an open console page can tell
 * when it changed elsewhere (the webmail) and refresh. POST: the image as the raw body (PNG, JPEG or WebP, up to the
 * shared cap), checked and re-encoded by the service. DELETE: removes it. Changes are audited in each of the person's
 * accounts, never with the image.
 */
export const GET = route(async ({ req }) => {
  return ok({ url: avatarUrl("/api/avatars", await ownAvatar(container().deps, await getActor(req.headers))) });
});

export const POST = route(
  async ({ req, meta }) => {
    const actor = await getActor(req.headers);
    // Signed in before the body is read (see withAvatarUpload); the service checks everything else.
    if (actor.kind !== "user") throw new UnauthenticatedError();
    return withAvatarUpload(req, async (bytes) => {
      const ref = await setOwnAvatar(container().deps, avatarImages(), actor, bytes, meta);
      return ok({ url: avatarUrl("/api/avatars", ref) });
    });
  },
  { limit: "avatarUpload" },
);

export const DELETE = route(async ({ req, meta }) => {
  await removeOwnAvatar(container().deps, await getActor(req.headers), meta);
  return ok({ url: null });
});
