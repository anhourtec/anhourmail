// SPDX-License-Identifier: AGPL-3.0-only
import { UnauthenticatedError } from "@anhourmail/core";
import { ALL_PERMISSIONS } from "@anhourmail/shared/rbac";
import { can } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { ok, route } from "@/server/http/route";

/** The signed-in person, their roles and the platform/self permissions the UI may show. */
export const GET = route(async ({ req }) => {
  const actor = await getActor(req.headers);
  if (actor.kind !== "user") throw new UnauthenticatedError();
  return ok({
    userId: actor.userId,
    email: actor.email,
    platformRoles: actor.platformRoles,
    memberships: actor.memberships,
    permissions: ALL_PERMISSIONS.filter((p) => can(actor, p)),
  });
});
