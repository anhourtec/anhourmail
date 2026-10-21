// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  accountRoleCan,
  PERMISSIONS,
  type Permission,
  type PlatformRole,
  platformRoleCan,
} from "@anhourmail/shared/rbac";

import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./errors";

/** Who is asking. Built by the app from the session; services never trust client-supplied roles. */
export type Membership = { accountId: string; role: AccountRole };

export type UserActor = {
  kind: "user";
  userId: string;
  email: string;
  /** Display name, for the console's menus (never used for decisions). */
  name?: string;
  platformRoles: readonly PlatformRole[];
  memberships: readonly Membership[];
  suspended: boolean;
  /** Set during a staff "act as" session: the staff member really acting. */
  actingAs?: { staffUserId: string; staffEmail: string; staffRole: PlatformRole; reason: string };
};

export type Actor = { kind: "anonymous" } | UserActor | { kind: "system"; name: string };

export const ANONYMOUS: Actor = { kind: "anonymous" };

export function can(actor: Actor, permission: Permission, accountId?: string): boolean {
  if (actor.kind === "system") return true;
  const def = PERMISSIONS[permission];
  if (actor.kind === "anonymous" || actor.suspended) return false;
  switch (def.scope) {
    case "self":
      return true;
    case "platform":
      return actor.platformRoles.some((r) => platformRoleCan(r, permission));
    case "account": {
      if (accountId === undefined) return false;
      const m = actor.memberships.find((x) => x.accountId === accountId);
      return m !== undefined && accountRoleCan(m.role, permission);
    }
  }
}

/**
 * The service-layer gate (CLAUDE.md rules 5, 25): 401 when signed out, 404 when the account isn't the
 * actor's (never confirm it exists), 403 when the role lacks the permission.
 */
export function authorize(actor: Actor, permission: Permission, accountId?: string): void {
  if (can(actor, permission, accountId)) return;
  const scope = PERMISSIONS[permission].scope;
  if (actor.kind === "anonymous") throw new UnauthenticatedError();
  if (actor.kind === "user" && scope === "account") {
    const member = accountId !== undefined && actor.memberships.some((m) => m.accountId === accountId);
    if (!member) throw new NotFoundError();
  }
  throw new ForbiddenError();
}
