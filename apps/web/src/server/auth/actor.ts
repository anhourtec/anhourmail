// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { sessionUser } from "@anhourmail/adapters/auth";
import { ANONYMOUS, type Actor } from "@anhourmail/core";
import { endSessionForRequirement, requiredEnrolment, sessionRefusalFor } from "@anhourmail/core/security";
import { requestContext } from "@anhourmail/server/request-context";

import { container } from "../container";
import { auth } from "./instance";

/**
 * The actor for this request and the id of its console session (for "this session" on the Security page). Roles,
 * suspension and the enrolment gate (a sign-in factor one of their accounts requires) always come from the database.
 * A session whose sign-in method an account requirement no longer accepts (e.g. it was set after they signed in) is
 * ended here, audited, and the request treated as signed out: they sign in again with what the account requires.
 */
export async function getActorAndSession(headers: Headers): Promise<{ actor: Actor; sessionId: string | null }> {
  const user = await sessionUser(auth(), headers);
  if (!user) return { actor: ANONYMOUS, sessionId: null };
  const ctx = requestContext();
  if (ctx) ctx.userId = user.id;
  // Sequential: a transaction holds one database connection, which runs one query at a time.
  const [platformRoles, memberships, suspended, mustEnrol, refusal] = await container().deps.uow.run(
    async (r) =>
      [
        await r.access.platformRoles(user.id),
        await r.access.memberships(user.id),
        await r.access.isSuspended(user.id),
        await requiredEnrolment(r, user.id),
        await sessionRefusalFor(r, user.id, user.signInMethod),
      ] as const,
  );
  if (refusal) {
    const c = requestContext();
    await endSessionForRequirement(
      container().deps,
      { userId: user.id, email: user.email, sessionId: user.sessionId, method: user.signInMethod },
      { requestId: c?.requestId ?? "auth", ip: c?.clientIp ?? null, userAgent: headers.get("user-agent") },
    );
    return { actor: ANONYMOUS, sessionId: null };
  }
  return {
    actor: {
      kind: "user",
      userId: user.id,
      email: user.email,
      name: user.name,
      platformRoles,
      memberships,
      suspended,
      ...(mustEnrol ? { mustEnrol } : {}),
      ...(user.signInMethod ? { signInMethod: user.signInMethod } : {}),
    },
    sessionId: user.sessionId,
  };
}

/** The actor for this request, from the console session (roles from the database). */
export async function getActor(headers: Headers): Promise<Actor> {
  return (await getActorAndSession(headers)).actor;
}
