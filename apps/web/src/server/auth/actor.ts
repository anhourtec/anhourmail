// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { sessionUser } from "@anhourmail/adapters/auth";
import { ANONYMOUS, type Actor } from "@anhourmail/core";
import { requestContext } from "@anhourmail/server/request-context";

import { container } from "../container";
import { auth } from "./instance";

/** The actor for this request, from the console session. Roles always come from the database. */
export async function getActor(headers: Headers): Promise<Actor> {
  const user = await sessionUser(auth(), headers);
  if (!user) return ANONYMOUS;
  const ctx = requestContext();
  if (ctx) ctx.userId = user.id;
  const [platformRoles, memberships, suspended] = await container().deps.uow.run((r) =>
    Promise.all([r.access.platformRoles(user.id), r.access.memberships(user.id), r.access.isSuspended(user.id)]),
  );
  return { kind: "user", userId: user.id, email: user.email, platformRoles, memberships, suspended };
}
