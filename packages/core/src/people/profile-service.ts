// SPDX-License-Identifier: AGPL-3.0-only
import { PROFILE_FIELDS, type ProfileDetails, type ProfileField } from "@anhourmail/shared/profile";

import { type Actor, authorize, can } from "../actor";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { profileDetails } from "./entity";
import { holdsPlatformRole, personName, queuePersonNameSync } from "./names";

/**
 * Optional profile details after creation ("Edit profile"): job title, department, office, phones, postal address and
 * country (`packages/shared/src/profile.ts`). Personal data: never logged, and audited only as which fields changed.
 *
 * Who may edit: the person themself (`self.profile.manage`, from their Profile page or their own person panel), and in
 * an account, admins with `member.manage` for a Member; someone with another role needs an Owner
 * (`account.admins.manage`), as for changing or removing them. The details belong to the person, not to one account:
 * someone who also belongs to another account, or holds a platform role (staff), is edited only by themself, so one
 * account's admins can't change what every other account (or the platform) sees, unaudited there.
 */

export type ProfileView = {
  details: ProfileDetails;
  /** Whether this viewer may edit them. */
  canEdit: boolean;
  /**
   * Why an admin looking at someone's details can't edit them (shown beside the read-only details); absent when they
   * can, and for viewers whose role doesn't manage people anyway.
   */
  readOnlyReason?: string;
};

/** The fields whose value differs (added, changed or removed), in the shared field order. */
export function changedFields(before: ProfileDetails, after: ProfileDetails): ProfileField[] {
  return PROFILE_FIELDS.filter((f) => (before[f] ?? "") !== (after[f] ?? ""));
}

const selfId = (actor: Actor): string | null => (actor.kind === "user" ? actor.userId : null);

/**
 * Someone else's details are refused for their role here, or because they also belong to another account or hold a
 * platform role (`holdsPlatformRole`).
 */
export type EditRefusal = "role" | "other_account";

/**
 * Why this actor may not edit the profile of `target` in the account (already known to be a member there), or null.
 * The same rule covers their profile photo (`avatars/service.ts`).
 */
export async function editRefusal(
  repos: Repositories,
  actor: Actor,
  accountId: string,
  target: { userId: string; role: string },
): Promise<EditRefusal | null> {
  if (target.userId === selfId(actor)) return null;
  if (
    !can(actor, "account.admins.manage", accountId) &&
    !(target.role === "member" && can(actor, "member.manage", accountId))
  ) {
    return "role";
  }
  return (await repos.accounts.membershipCount(target.userId)) > 1 || (await holdsPlatformRole(repos, target.userId))
    ? "other_account"
    : null;
}

export const OTHER_ACCOUNT_PROFILE =
  "This person also belongs to another account, so only they can change their profile.";

export const ROLE_PROFILE = "Only an owner can edit the profile of an owner or an admin.";

/**
 * Staff acting in a customer account (ADR-0023) change no profile or photo, their own included: it would land in the
 * customer's log as a change by Anhourtec staff. Refused as 403, audited as denied `act_as`.
 */
export const ACTING_PROFILE =
  "You can't change profiles or photos while you have support access open, your own included. End it first.";

/** True while the actor is staff acting in a customer account. */
export const actingAsStaff = (actor: Actor): boolean => actor.kind === "user" && actor.actingAs !== undefined;

/** The member of the account with this id; a 404 for anyone else (never confirms another account's people). */
export async function memberOf(repos: Repositories, accountId: string, userId: string) {
  const target =
    userId.length <= 200 ? (await repos.people.list(accountId)).find((m) => m.userId === userId) : undefined;
  if (!target) throw new NotFoundError();
  return target;
}

/** A person's profile details in an account's People page (`member.read`; someone outside the account is a 404). */
export async function getPersonProfile(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
): Promise<ProfileView> {
  authorize(actor, "member.read", accountId);
  return deps.uow.run(async (repos) => {
    const target = await memberOf(repos, accountId, userId);
    const refusal = await editRefusal(repos, actor, accountId, target);
    const reason =
      refusal === "other_account"
        ? OTHER_ACCOUNT_PROFILE
        : refusal === "role" && can(actor, "member.manage", accountId)
          ? ROLE_PROFILE
          : null;
    return {
      details: await repos.people.profile(target.userId),
      canEdit: refusal === null,
      ...(reason ? { readOnlyReason: reason } : {}),
    };
  });
}

/** The signed-in person's own profile details (their Profile page). */
export async function getOwnProfile(deps: Deps, actor: Actor): Promise<ProfileView> {
  authorize(actor, "self.profile.read");
  if (actor.kind !== "user") throw new UnauthenticatedError();
  return deps.uow.run(async (repos) => ({
    details: await repos.people.profile(actor.userId),
    canEdit: can(actor, "self.profile.manage"),
  }));
}

/** What changed: the optional details' field names, and `name` when the person's name changed. */
export type ProfileChange = { details: ProfileDetails; changed: (ProfileField | "name")[]; name?: string };

/**
 * Applies a profile edit inside the caller's unit of work: the details (replaced, unless only the name was sent) and
 * the name when given. A new name is the sender name of every mailbox of theirs that follows it, so it queues the
 * worker to write it to the mail server (`queuePersonNameSync`). Returns what changed.
 */
async function applyProfileEdit(
  deps: Deps,
  repos: Repositories,
  userId: string,
  input: { profile?: unknown; name?: unknown },
): Promise<ProfileChange> {
  const nameGiven = input.name !== undefined && input.name !== null;
  const name = nameGiven ? personName(input.name) : undefined;
  const before = await repos.people.profile(userId);
  // Without a name, the details are always replaced (an absent `profile` clears them, as before names were editable).
  const after = input.profile === undefined && nameGiven ? before : profileDetails(input.profile ?? {});
  const changed: (ProfileField | "name")[] = changedFields(before, after);
  if (changed.length > 0) await repos.people.setProfile(userId, after);
  if (name !== undefined && name !== ((await repos.suspensions.personInfo(userId))?.name ?? "")) {
    await repos.people.setName(userId, name);
    await queuePersonNameSync(repos, userId, deps.clock.now());
    changed.unshift("name");
  }
  return { details: after, changed, ...(name !== undefined ? { name } : {}) };
}

/**
 * An admin's (or the person's own) edit from the People page (`member.manage`, plus the role rule above; the person
 * themself always may). Replaces all the fields: an empty one clears it. `name`, when given, is the person's name (the
 * sender name of their mailboxes that follow it). Audited as `account.profile_changed` in the
 * account's log with the names of the fields that changed; a refusal by role (`forbidden`), or because the person also
 * belongs to another account (`other_account`), is audited as denied (403).
 */
export async function updatePersonProfile(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
  input: { profile?: unknown; name?: unknown },
  req: RequestMeta,
): Promise<ProfileChange> {
  const own = userId === selfId(actor);
  const out = await mutation<ProfileChange | EditRefusal | "act_as">(
    deps,
    actor,
    req,
    {
      action: "account.profile_changed",
      // Your own details are yours to edit whatever your role; you still have to be in the account (404 otherwise).
      permission: own ? "self.profile.manage" : "member.manage",
      accountId,
      target: { type: "person", id: userId },
    },
    async (repos) => {
      if (actingAsStaff(actor)) return { result: "act_as" as const, denied: { code: "act_as" } };
      if (own && !(actor.kind === "user" && actor.memberships.some((m) => m.accountId === accountId))) {
        throw new NotFoundError();
      }
      const target = await memberOf(repos, accountId, userId);
      const refusal = await editRefusal(repos, actor, accountId, target);
      if (refusal !== null) {
        return {
          result: refusal,
          target: { label: target.email },
          denied: { code: refusal === "role" ? "forbidden" : refusal },
        };
      }
      const result = await applyProfileEdit(deps, repos, target.userId, input);
      return {
        result,
        target: { label: target.email },
        // Which fields changed, never their values (personal data).
        meta: { fields: result.changed, self: own },
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError(ACTING_PROFILE);
  if (out === "role") throw new ForbiddenError(ROLE_PROFILE);
  if (out === "other_account") throw new ForbiddenError(OTHER_ACCOUNT_PROFILE);
  return out;
}

/**
 * The person's own edit from their Profile page (`self.profile.manage`): the details and, when given, their name.
 * Recorded as `account.profile_changed` in each account they belong to (so its admins see it), with the names of the
 * fields that changed (`name` included); in the platform log when they belong to none.
 */
export async function updateOwnProfile(
  deps: Deps,
  actor: Actor,
  input: { profile?: unknown; name?: unknown },
  req: RequestMeta,
): Promise<ProfileChange> {
  const accounts = actor.kind === "user" ? [...new Set(actor.memberships.map((m) => m.accountId))] : [];
  const [first, ...rest] = accounts;
  const out = await mutation<ProfileChange | "act_as">(
    deps,
    actor,
    req,
    {
      action: "account.profile_changed",
      permission: "self.profile.manage",
      accountId: first ?? null,
      target: { type: "person", id: selfId(actor) },
    },
    async (repos) => {
      if (actor.kind !== "user") throw new UnauthenticatedError();
      if (actingAsStaff(actor)) return { result: "act_as", target: { label: actor.email }, denied: { code: "act_as" } };
      const result = await applyProfileEdit(deps, repos, actor.userId, input);
      const meta = { fields: result.changed, self: true };
      return {
        result,
        target: { label: actor.email },
        meta,
        copies: rest.map((accountId) => ({ accountId, meta })),
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError(ACTING_PROFILE);
  return out;
}
