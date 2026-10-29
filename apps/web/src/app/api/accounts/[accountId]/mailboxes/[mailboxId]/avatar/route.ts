// SPDX-License-Identifier: AGPL-3.0-only
import { removeMailboxAvatar, setMailboxAvatar } from "@anhourmail/core/avatars";

import { UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { avatarImages, avatarUrl, withAvatarUpload } from "@/server/avatars";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * The photo of a mailbox without a person (a shared address), from the Mailboxes page (`mailbox.manage`; ADR-0022).
 * A mailbox with a person shows the person's photo instead (409). Another account's mailbox is a 404.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const actor = await getActor(req.headers);
    // Signed in before the body is read (see withAvatarUpload); the service checks everything else.
    if (actor.kind !== "user") throw new UnauthenticatedError();
    return withAvatarUpload(req, async (bytes) => {
      const ref = await setMailboxAvatar(
        container().deps,
        avatarImages(),
        actor,
        str(params.accountId),
        str(params.mailboxId),
        bytes,
        meta,
      );
      return ok({ url: avatarUrl("/api/avatars", ref) });
    });
  },
  { limit: "avatarUpload" },
);

export const DELETE = route(async ({ req, meta }, params) => {
  await removeMailboxAvatar(
    container().deps,
    await getActor(req.headers),
    str(params.accountId),
    str(params.mailboxId),
    meta,
  );
  return ok({ url: null });
});
