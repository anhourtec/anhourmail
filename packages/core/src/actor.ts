// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  accountRoleCan,
  PERMISSIONS,
  type Permission,
  type PlatformRole,
  platformRoleCan,
} from "@anhourmail/shared/rbac";
import type { SignInMethod } from "@anhourmail/shared/security";

import {
  AccountSuspendedError,
  EnrolmentRequiredError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "./errors";

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
  /**
   * A sign-in factor one of their accounts requires and they haven't set up (core `missingFactor`). While set, only
   * `self` permissions pass: everything else answers `EnrolmentRequiredError` until they enrol.
   */
  mustEnrol?: "two_factor" | "passkey";
  /** How the current console session was signed in (shared/security.ts), when known. */
  signInMethod?: SignInMethod;
  /**
   * Their accounts that Anhourtec staff suspended (`platform.account.suspend`): every account permission there answers
   * `AccountSuspendedError` (403 `account_suspended`) until it is lifted. Platform and `self` permissions are unaffected.
   */
  suspendedAccountIds?: readonly string[];
};

export type Actor = { kind: "anonymous" } | UserActor | { kind: "system"; name: string };

export const ANONYMOUS: Actor = { kind: "anonymous" };

/** The matrix alone, before the enrolment gate. */
function granted(actor: Actor, permission: Permission, accountId?: string): boolean {
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

/** True when the actor's enrolment gate blocks this permission (everything but `self` while a factor is missing). */
const gated = (actor: Actor, permission: Permission): actor is UserActor & { mustEnrol: "two_factor" | "passkey" } =>
  actor.kind === "user" && actor.mustEnrol !== undefined && PERMISSIONS[permission].scope !== "self";

/** True when the permission is an account one in an account staff have suspended. */
const accountSuspended = (actor: Actor, permission: Permission, accountId?: string): boolean =>
  actor.kind === "user" &&
  accountId !== undefined &&
  PERMISSIONS[permission].scope === "account" &&
  (actor.suspendedAccountIds?.includes(accountId) ?? false);

export function can(actor: Actor, permission: Permission, accountId?: string): boolean {
  return (
    granted(actor, permission, accountId) &&
    !gated(actor, permission) &&
    !accountSuspended(actor, permission, accountId)
  );
}

/**
 * The service-layer gate (CLAUDE.md rules 5, 25): 401 when signed out, 404 when the account isn't the
 * actor's (never confirm it exists), 403 when the role lacks the permission, and 403 `enrolment_required` when the
 * role allows it but one of their accounts requires a sign-in factor they haven't set up; 403 `account_suspended` when
 * the account is suspended by staff.
 */
export function authorize(actor: Actor, permission: Permission, accountId?: string): void {
  if (granted(actor, permission, accountId)) {
    if (accountSuspended(actor, permission, accountId)) throw new AccountSuspendedError();
    if (gated(actor, permission)) throw new EnrolmentRequiredError(actor.mustEnrol);
    return;
  }
  const scope = PERMISSIONS[permission].scope;
  if (actor.kind === "anonymous") throw new UnauthenticatedError();
  if (actor.kind === "user" && scope === "account") {
    const member = accountId !== undefined && actor.memberships.some((m) => m.accountId === accountId);
    if (!member) throw new NotFoundError();
  }
  throw new ForbiddenError();
}
