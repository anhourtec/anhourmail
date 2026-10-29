// SPDX-License-Identifier: AGPL-3.0-only
import { removePersonAvatar, setPersonAvatar } from "@anhourmail/core/avatars";

import { UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { avatarImages, avatarUrl, withAvatarUpload } from "@/server/avatars";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * A person's profile photo from the People page (ADR-0022): who may change it follows "Edit profile" — the person
 * themself, `member.manage` for a Member, an Owner for anyone else, and only the person when they also belong to
 * another account. Someone outside the account is a 404. POST takes the raw image; DELETE removes it.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    // Signed in before the body is read (see withAvatarUpload); the service checks everything else.
    if (actor.kind !== "user") throw new UnauthenticatedError();
    return withAvatarUpload(req, async (bytes) => {
      const ref = await setPersonAvatar(
        container().deps,
        avatarImages(),
        actor,
        str(params.accountId),
        str(params.userId),
        bytes,
        meta,
      );
      return ok({ url: avatarUrl("/api/avatars", ref) });
    });
  },
  { limit: "avatarUpload" },
);

export const DELETE = route(async ({ req, meta }, params) => {
  await removePersonAvatar(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    str(params.userId),
    meta,
  );
  return ok({ url: null });
});
