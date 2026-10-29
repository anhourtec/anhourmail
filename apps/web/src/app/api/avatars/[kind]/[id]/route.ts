// SPDX-License-Identifier: AGPL-3.0-only
import { avatarImage } from "@anhourmail/core/avatars";

import { getActor } from "@/server/auth/actor";
import { avatarOwnerParam, avatarResponse } from "@/server/avatars";
import { container } from "@/server/container";
import { route } from "@/server/http/route";

/**
 * A profile photo on the console origin (`/api/avatars/person/:userId?v=…`, `/api/avatars/mailbox/:mailboxId?v=…`):
 * for the person, people in their accounts who may see people or mailboxes, and staff who may look up accounts
 * (the service decides; 404 for anyone else and for a photo that doesn't exist). Cached privately under the version.
 */
export const GET = route(
  async ({ req }, params) => {
    const image = await avatarImage(container().deps, await getActor(req.headers), avatarOwnerParam(params));
    return avatarResponse(image, req);
  },
  { cache: "handler" },
);
