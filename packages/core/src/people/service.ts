// SPDX-License-Identifier: AGPL-3.0-only
import { INVITE_EMAILS_PER_DAY, INVITE_TTL_DAYS, MAX_PEOPLE, PLANS } from "@anhourmail/shared/plans";
import { ACCOUNT_ROLES, type AccountRole } from "@anhourmail/shared/rbac";

import { type Actor, authorize, can } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, ForbiddenError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { hashToken, isTokenShaped, newToken } from "../tokens";
import { checkPassword, type Invite, isAccountRole, loginNames, type MemberRecord, normaliseEmail } from "./entity";

/**
 * People and roles in a customer account (docs/internal/roles.md). Guard rails, all enforced here:
 * - `member.read` sees the list; `member.manage` (Owner, User Administrator) invites Members and removes Members;
 * - every other role is Owner-only (`account.admins.manage`): inviting with it, changing anyone's role, removing an
 *   Owner or an admin — a User Administrator gets 403, audited as `denied`;
 * - nobody changes their own role or removes themselves (no self-escalation), and the last Owner can't be removed
 *   or demoted (409).
 * Invites are 7-day single-use links bound to an email address; only the token's hash is stored.
 */

export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 3600_000;
/** A resend within this long of the last send is refused (the mail is probably on its way). */
export const RESEND_GAP_MS = 60_000;

export type MemberView = {
  userId: string;
  name: string;
  email: string;
  role: AccountRole;
  status: "active" | "suspended";
  joinedAt: Date;
  isYou: boolean;
  /** What the viewer may do to this person (the console shows only these actions; the server checks again). */
  canChangeRole: boolean;
  canRemove: boolean;
};

export type InviteView = {
  id: string;
  email: string;
  role: AccountRole;
  sentAt: Date;
  expiresAt: Date;
  expired: boolean;
  /** The viewer may resend or revoke it. */
  canManage: boolean;
};

export type PeopleOverview = {
  members: MemberView[];
  invites: InviteView[];
  /** Roles the viewer may invite with (empty when they can't invite). */
  grantableRoles: AccountRole[];
  /** People and pending invites against the account's ceiling; `addPeople` false on plans with one person. */
  limits: { used: number; max: number; addPeople: boolean; planName: string };
};

const selfId = (actor: Actor): string | null => (actor.kind === "user" ? actor.userId : null);
const ownerCount = (members: readonly MemberRecord[]) => members.filter((m) => m.role === "owner").length;

/** Roles the actor may hand out: every role for an Owner, Member only for a User Administrator. */
export function grantableRoles(actor: Actor, accountId: string): AccountRole[] {
  if (can(actor, "account.admins.manage", accountId)) return [...ACCOUNT_ROLES];
  if (can(actor, "member.manage", accountId)) return ["member"];
  return [];
}

/** Changing or removing someone in this role needs `account.admins.manage` unless it's a Member. */
const mayTouch = (actor: Actor, accountId: string, role: AccountRole) =>
  can(actor, "account.admins.manage", accountId) || (role === "member" && can(actor, "member.manage", accountId));

const sentAt = (i: Invite) => new Date(i.expiresAt.getTime() - INVITE_TTL_MS);

function inviteView(actor: Actor, accountId: string, i: Invite, now: Date): InviteView {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    sentAt: sentAt(i),
    expiresAt: i.expiresAt,
    expired: i.expiresAt <= now,
    canManage: mayTouch(actor, accountId, i.role),
  };
}

function memberView(actor: Actor, accountId: string, m: MemberRecord, owners: number): MemberView {
  const isYou = m.userId === selfId(actor);
  const lastOwner = m.role === "owner" && owners <= 1;
  return {
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.suspended ? "suspended" : "active",
    joinedAt: m.joinedAt,
    isYou,
    canChangeRole: !isYou && !lastOwner && can(actor, "account.admins.manage", accountId),
    canRemove: !isYou && !lastOwner && mayTouch(actor, accountId, m.role),
  };
}

async function accountOf(repos: Repositories, accountId: string) {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  return account;
}

const liveInvites = (invites: readonly Invite[], now: Date) => invites.filter((i) => i.expiresAt > now);

/** The People page: members, pending invites, what the viewer may do, and the account's ceiling (`member.read`). */
export async function listPeople(deps: Deps, actor: Actor, accountId: string): Promise<PeopleOverview> {
  authorize(actor, "member.read", accountId);
  return deps.uow.run(async (r) => {
    const account = await accountOf(r, accountId);
    const members = await r.people.list(accountId);
    const invites = await r.invites.listPending(accountId);
    const now = deps.clock.now();
    const owners = ownerCount(members);
    const plan = PLANS[account.plan];
    return {
      members: members.map((m) => memberView(actor, accountId, m, owners)),
      invites: invites.map((i) => inviteView(actor, accountId, i, now)),
      grantableRoles: plan.addPeople ? grantableRoles(actor, accountId) : [],
      limits: {
        used: members.length + liveInvites(invites, now).length,
        max: MAX_PEOPLE,
        addPeople: plan.addPeople,
        planName: plan.name,
      },
    };
  });
}

/** What the route needs to email the link. The token never leaves the server except in that email. */
export type SentInvite = { invite: InviteView; token: string; accountName: string };

async function assertRoom(repos: Repositories, accountId: string, now: Date, exclude?: string): Promise<void> {
  const account = await accountOf(repos, accountId);
  const plan = PLANS[account.plan];
  if (!plan.addPeople) {
    throw new PlanLimitError(`The ${plan.name} plan is for one person. Upgrade to add people to this account.`);
  }
  const members = (await repos.people.list(accountId)).length;
  const invites = liveInvites(await repos.invites.listPending(accountId), now).filter((i) => i.id !== exclude);
  if (members + invites.length >= MAX_PEOPLE) {
    throw new PlanLimitError(`An account can have up to ${String(MAX_PEOPLE)} people, counting pending invites.`);
  }
}

const DAY_MS = 24 * 3600_000;

/**
 * The per-account daily cap on invite emails (first sends and resends, from the send log — revoking doesn't give
 * any back). Checked and recorded inside the unit of work, under the account lock, so it holds under races.
 */
async function assertSendAllowed(repos: Repositories, accountId: string, now: Date): Promise<void> {
  if ((await repos.invites.sendsSince(accountId, new Date(now.getTime() - DAY_MS))) >= INVITE_EMAILS_PER_DAY) {
    throw new ConflictError(
      `This account has sent ${String(INVITE_EMAILS_PER_DAY)} invite emails in the last day, the most it can. Try again later.`,
    );
  }
}

const ROLE_DENIED = "Only an owner can invite, change or remove someone with that role.";

/**
 * Invites someone by email (`member.manage`; any role but Member needs `account.admins.manage`). The route emails the
 * link; resending issues a new one. Refused for people already in the account or already invited.
 */
export async function invitePerson(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { email?: unknown; role?: unknown },
  req: RequestMeta,
): Promise<SentInvite> {
  const out = await mutation<SentInvite | null>(
    deps,
    actor,
    req,
    { action: "account.invite_sent", permission: "member.manage", accountId, target: { type: "invite" } },
    async (repos) => {
      const role = input.role === undefined || input.role === null || input.role === "" ? "member" : input.role;
      if (!isAccountRole(role)) throw new ValidationError("Choose a role.");
      if (!mayTouch(actor, accountId, role)) return { result: null, meta: { role }, denied: { code: "forbidden" } };
      const email = normaliseEmail(input.email);
      await repos.accounts.lock(accountId); // the people ceiling and "one invite per address" hold under races
      const now = deps.clock.now();
      if ((await repos.people.list(accountId)).some((m) => m.email === email)) {
        throw new ConflictError("That person is already in this account.");
      }
      if ((await repos.invites.listPending(accountId)).some((i) => i.email === email)) {
        throw new ConflictError("That address already has an invite. Resend it instead.");
      }
      await assertRoom(repos, accountId, now);
      await assertSendAllowed(repos, accountId, now);
      const token = newToken();
      const invite = await repos.invites.create({
        accountId,
        email,
        role,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        createdBy: selfId(actor),
        createdAt: now,
        tokenHash: hashToken(token),
      });
      await repos.invites.recordSend(accountId, invite.id, now);
      return {
        result: {
          invite: inviteView(actor, accountId, invite, now),
          token,
          accountName: (await accountOf(repos, accountId)).name,
        },
        target: { id: invite.id, label: email },
        meta: { role },
      };
    },
  );
  if (out === null) throw new ForbiddenError(ROLE_DENIED);
  return out;
}

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scopedInvite(repos: Repositories, accountId: string, id: string): Promise<Invite> {
  const invite = isId(id) ? await repos.invites.get(accountId, id) : null;
  if (!invite) throw new NotFoundError();
  if (invite.status !== "pending") throw new ConflictError("This invite has already been used or revoked.");
  return invite;
}

/** Sends a pending invite again with a new link and a fresh 7 days (the old link stops working). */
export async function resendInvite(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<SentInvite> {
  const out = await mutation<SentInvite | null>(
    deps,
    actor,
    req,
    { action: "account.invite_resent", permission: "member.manage", accountId, target: { type: "invite", id } },
    async (repos) => {
      const invite = await scopedInvite(repos, accountId, id);
      if (!mayTouch(actor, accountId, invite.role)) {
        return {
          result: null,
          target: { label: invite.email },
          meta: { role: invite.role },
          denied: { code: "forbidden" },
        };
      }
      await repos.accounts.lock(accountId);
      const now = deps.clock.now();
      if (now.getTime() - sentAt(invite).getTime() < RESEND_GAP_MS) {
        throw new ConflictError("This invite was just sent. Wait a minute before sending it again.");
      }
      if (invite.expiresAt <= now) await assertRoom(repos, accountId, now, invite.id);
      await assertSendAllowed(repos, accountId, now);
      const token = newToken();
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      if (!(await repos.invites.reissue(invite.id, hashToken(token), expiresAt))) {
        throw new ConflictError("This invite has already been used or revoked.");
      }
      await repos.invites.recordSend(accountId, invite.id, now);
      return {
        result: {
          invite: inviteView(actor, accountId, { ...invite, expiresAt }, now),
          token,
          accountName: (await accountOf(repos, accountId)).name,
        },
        target: { label: invite.email },
        meta: { role: invite.role, wasExpired: invite.expiresAt <= now },
      };
    },
  );
  if (out === null) throw new ForbiddenError(ROLE_DENIED);
  return out;
}

/** Revokes a pending invite: its link stops working at once. */
export async function revokeInvite(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<{ id: string }> {
  const out = await mutation<{ id: string } | null>(
    deps,
    actor,
    req,
    { action: "account.invite_revoked", permission: "member.manage", accountId, target: { type: "invite", id } },
    async (repos) => {
      const invite = await scopedInvite(repos, accountId, id);
      if (!mayTouch(actor, accountId, invite.role)) {
        return {
          result: null,
          target: { label: invite.email },
          meta: { role: invite.role },
          denied: { code: "forbidden" },
        };
      }
      if (!(await repos.invites.revoke(invite.id))) {
        throw new ConflictError("This invite has already been used or revoked.");
      }
      return { result: { id: invite.id }, target: { label: invite.email }, meta: { role: invite.role } };
    },
  );
  if (out === null) throw new ForbiddenError(ROLE_DENIED);
  return out;
}

/** A member of the account, else 404 (ids from another account are never confirmed). */
async function scopedMember(repos: Repositories, accountId: string, userId: string) {
  const members = await repos.people.list(accountId);
  const target = userId.length <= 200 ? members.find((m) => m.userId === userId) : undefined;
  if (!target) throw new NotFoundError();
  return { target, members };
}

const LAST_OWNER = "An account always has at least one owner. Make someone else an owner first.";

/** Changes someone's role (`account.admins.manage`: Owners). Not your own, and never the last Owner's. */
export async function changeMemberRole(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
  input: { role?: unknown },
  req: RequestMeta,
): Promise<MemberView> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "account.role_changed",
      permission: "account.admins.manage",
      accountId,
      target: { type: "person", id: userId },
    },
    async (repos) => {
      await repos.accounts.lock(accountId); // two Owners demoting each other can't leave the account without one
      const { target, members } = await scopedMember(repos, accountId, userId);
      if (!isAccountRole(input.role)) throw new ValidationError("Choose a role.");
      const role = input.role;
      if (target.userId === selfId(actor)) {
        throw new ConflictError("You can't change your own role. Ask another owner to do it.");
      }
      if (target.role === role) throw new ConflictError("They already have that role.");
      if (target.role === "owner" && ownerCount(members) <= 1) throw new ConflictError(LAST_OWNER);
      if (!(await repos.people.setRole(accountId, target.userId, role))) throw new NotFoundError();
      const after = members.map((m) => (m.userId === target.userId ? { ...m, role } : m));
      return {
        result: memberView(actor, accountId, { ...target, role }, ownerCount(after)),
        target: { label: target.email },
        meta: { previousRole: target.role, newRole: role },
      };
    },
  );
}

/**
 * Removes someone from the account (`member.manage`; an Owner or an admin needs `account.admins.manage`). Not
 * yourself, and never the last Owner. Their mailboxes stay (unassigned) — suspend or delete them separately.
 */
export async function removeMember(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
  req: RequestMeta,
): Promise<{ userId: string }> {
  const out = await mutation<{ userId: string } | null>(
    deps,
    actor,
    req,
    {
      action: "account.member_removed",
      permission: "member.manage",
      accountId,
      target: { type: "person", id: userId },
    },
    async (repos) => {
      await repos.accounts.lock(accountId);
      const { target, members } = await scopedMember(repos, accountId, userId);
      if (!mayTouch(actor, accountId, target.role)) {
        return {
          result: null,
          target: { label: target.email },
          meta: { role: target.role },
          denied: { code: "forbidden" },
        };
      }
      if (target.userId === selfId(actor)) throw new ConflictError("You can't remove yourself from the account.");
      if (target.role === "owner" && ownerCount(members) <= 1) throw new ConflictError(LAST_OWNER);
      if (!(await repos.people.remove(accountId, target.userId))) throw new NotFoundError();
      const mailboxes = (await repos.mailboxes.listByAccount(accountId)).filter((m) => m.userId === target.userId);
      return {
        result: { userId: target.userId },
        target: { label: target.email },
        meta: { role: target.role, mailboxesUnassigned: mailboxes.length },
      };
    },
  );
  if (out === null) throw new ForbiddenError(ROLE_DENIED);
  return out;
}

/** What the invite page shows to whoever holds the link. Null for an unknown, used or revoked link. Not audited. */
export type InviteLookup = {
  accountName: string;
  role: AccountRole;
  email: string;
  expired: boolean;
  /** A console login with the invited address exists (sign in to accept), else the page offers to create one. */
  hasLogin: boolean;
};

export async function lookupInvite(deps: Deps, token: unknown): Promise<InviteLookup | null> {
  if (!isTokenShaped(token)) return null;
  return deps.uow.run(async (r) => {
    const invite = await r.invites.findByToken(hashToken(token));
    if (invite?.status !== "pending") return null;
    const account = await r.accounts.get(invite.accountId);
    if (!account) return null;
    return {
      accountName: account.name,
      role: invite.role,
      email: invite.email,
      expired: invite.expiresAt <= deps.clock.now(),
      hasLogin: (await r.people.userByEmail(invite.email)) !== null,
    };
  });
}

const INVALID_INVITE = "This invite has expired, been used or been revoked. Ask for a new one.";

/**
 * Accepts an invite with the link's token. Signed in: the session's email must be the invited address. Signed out:
 * creates a console login for the invited address (the emailed link proved it) with the given names and password —
 * refused when that address already has a login (sign in instead). Either way the person joins with the invited role,
 * and the link is used up. `hashPassword` comes from the identity adapter (argon2id).
 */
export async function acceptInvite(
  deps: Deps,
  actor: Actor,
  input: { token?: unknown; firstName?: unknown; lastName?: unknown; password?: unknown },
  req: RequestMeta,
  hashPassword: (password: string) => Promise<string>,
): Promise<{ accountId: string; email: string; newLogin: boolean }> {
  if (!isTokenShaped(input.token)) {
    throw new ValidationError("This invite link is incomplete. Open it from the email again.");
  }
  const tokenHash = hashToken(input.token);
  const invite = await deps.uow.run((r) => r.invites.findByToken(tokenHash));
  if (invite?.status !== "pending" || invite.expiresAt <= deps.clock.now()) throw new NotFoundError(INVALID_INVITE);

  const user = actor.kind === "user" ? actor : null;
  // Signed out: validate and hash before the unit of work (argon2id is slow; never inside a transaction).
  const login = user ? null : { ...loginNames(input), passwordHash: await hashPassword(checkPassword(input.password)) };

  // Signed in as someone else: refused and recorded in the platform log (staff-only), like any probe from outside
  // the account — a non-member's address never lands in the inviting account's log.
  if (user && user.email.trim().toLowerCase() !== invite.email) {
    await mutation(
      deps,
      user,
      req,
      {
        action: "account.invite_accepted",
        permission: "self.profile.read",
        accountId: null,
        target: { type: "invite", id: invite.id, label: maskEmail(invite.email) },
      },
      async () => ({ result: null, meta: { reason: "different_address" }, denied: { code: "forbidden" } }),
    );
    throw new ForbiddenError("This invite was sent to a different address. Sign out, then open the link again.");
  }

  return mutation(
    deps,
    user ?? { kind: "system", name: "invite" },
    req,
    {
      action: "account.invite_accepted",
      permission: "self.profile.read",
      accountId: invite.accountId,
      target: { type: "invite", id: invite.id, label: invite.email },
    },
    async (repos) => {
      await repos.accounts.lock(invite.accountId);
      // The plan or the account may have changed since the invite was sent: re-check both under the lock. This
      // invite's own slot is already counted, so it doesn't count against itself.
      const account = await accountOf(repos, invite.accountId);
      if (!PLANS[account.plan].addPeople) {
        throw new PlanLimitError(
          `This account's plan (${PLANS[account.plan].name}) no longer includes other people, so the invite can't be used. Ask the person who invited you.`,
        );
      }
      const now = deps.clock.now();
      const others = liveInvites(await repos.invites.listPending(invite.accountId), now).filter(
        (i) => i.id !== invite.id,
      );
      if ((await repos.people.list(invite.accountId)).length + others.length >= MAX_PEOPLE) {
        throw new PlanLimitError("This account already has as many people as it can. Ask the person who invited you.");
      }
      let userId: string;
      if (login) {
        if (await repos.people.userByEmail(invite.email)) {
          throw new ConflictError("This address already has a login. Sign in, then open the invite link again.");
        }
        userId = (await repos.people.createLogin({ email: invite.email, ...login })).id;
      } else {
        userId = user?.userId ?? "";
      }
      if ((await repos.people.list(invite.accountId)).some((m) => m.userId === userId)) {
        throw new ConflictError("You're already in this account.");
      }
      if (!(await repos.invites.accept(invite.id, userId, now))) throw new NotFoundError(INVALID_INVITE);
      await repos.accounts.addMember({ accountId: invite.accountId, userId, role: invite.role });
      return {
        result: { accountId: invite.accountId, email: invite.email, newLogin: user === null },
        meta: { role: invite.role, newLogin: user === null, userId },
      };
    },
  );
}
