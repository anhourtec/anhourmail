// SPDX-License-Identifier: AGPL-3.0-only
import { generateMailboxPassword } from "@anhourmail/shared/security";
import type { AccountRole } from "@anhourmail/shared/rbac";

import { type Actor, can } from "../actor";
import { ConflictError, EmailUnverifiedError, ForbiddenError, ValidationError } from "../errors";
import { mutation, type MutationOutcome } from "../mutation";
import { checkPassword, displayName, isAccountRole, loginNames, profileDetails } from "../people/entity";
import { assertRoom, grantableRoles } from "../people/service";
import type { Deps, RequestMeta } from "../ports";
import { BreachedPasswordError, passwordBreached } from "../security/breached-passwords";
import { GB } from "./entity";
import { hashMailboxPassword, mailboxPassword, type PasswordHasher } from "./password-hash";
import {
  assertAddressFree,
  assertRoomForMailbox,
  type MailboxView,
  newMailbox,
  newMailboxAddress,
  viewOf,
} from "./service";

export type AddUserInput = {
  firstName?: unknown;
  lastName?: unknown;
  displayName?: unknown;
  localPart?: unknown;
  domainId?: unknown;
  role?: unknown;
  quotaGb?: unknown;
  /** Default true: the server generates a strong password and returns it once. */
  generatePassword?: unknown;
  /** The admin's own choice when `generatePassword` is false. */
  password?: unknown;
  /** Default true: console and webmail ask for a new password at first sign-in. */
  requirePasswordChange?: unknown;
  /** Optional profile details (`profileDetails`). */
  profile?: unknown;
};

export type AddedUser = {
  mailbox: MailboxView;
  userId: string;
  role: AccountRole;
  /** The generated password, shown to the admin once; null when they chose it. Never stored, logged or audited. */
  password: string | null;
  requirePasswordChange: boolean;
};

const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/**
 * "Add a user" (Mailboxes page): one person with one mailbox, in one audited unit of work. Creates the mailbox (on an
 * active domain of the account, or a free platform address), a console login whose sign-in email is the new address
 * (verified: the account controls it; no invite email), the membership with the chosen role, and links the person as
 * the mailbox's owner. The password is generated here (default) or chosen by the admin; the console stores a salted
 * argon2id hash of it (`hashLogin`, the identity adapter) and the mail server gets its own argon2id hash through the
 * worker — the password itself is never stored, queued, logged or audited (rule 23). With `requirePasswordChange`
 * (default) both the console and the webmail ask for a new password before anything else.
 *
 * Needs `mailbox.manage`, and the role must be one the actor may grant (`grantableRoles`: an Owner any, a User
 * Administrator Member only) — otherwise 403, audited as denied. Another account's id is a 404. Refused during a staff
 * act-as session (staff never choose a customer's password), on plans without people, at the people or mailbox
 * ceiling, when the storage pool is full, and when the address is taken or already has a console login.
 */
export async function addUser(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: AddUserInput,
  req: RequestMeta,
  hasher: PasswordHasher,
  hashLogin: (password: string) => Promise<string>,
): Promise<AddedUser> {
  const generate = flag(input.generatePassword, true);
  const requireChange = flag(input.requirePasswordChange, true);
  // The breached-password lookup runs before the unit of work (never while holding the account lock).
  const breached =
    !generate && can(actor, "mailbox.manage", accountId) && (await passwordBreached(hasher.breaches, input.password));
  const out = await mutation(
    deps,
    actor,
    req,
    { action: "account.user_added", permission: "mailbox.manage", accountId, target: { type: "mailbox" } },
    async (repos): Promise<MutationOutcome<AddedUser | "act_as" | "email_unverified" | "role">> => {
      if (actor.kind === "user" && actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      const role = input.role === undefined || input.role === null || input.role === "" ? "member" : input.role;
      if (!isAccountRole(role)) throw new ValidationError("Choose a role.");
      if (!grantableRoles(actor, accountId).includes(role)) {
        return { result: "role", meta: { role }, denied: { code: "forbidden" } };
      }
      const names = loginNames(input);
      const shown = displayName(input.displayName);
      const profile = profileDetails(input.profile);
      await repos.accounts.lock(accountId); // the people and mailbox ceilings hold under concurrent creates
      await assertRoom(repos, accountId, deps.clock.now());
      const target = await newMailboxAddress(deps, actor, repos, accountId, input);
      if (target === "email_unverified") return { result: "email_unverified", denied: { code: "email_unverified" } };
      const { address, onPlatform } = target;
      const quotaBytes = await assertRoomForMailbox(deps, repos, accountId, onPlatform, input.quotaGb);
      const password = generate ? generateMailboxPassword() : checkPassword(mailboxPassword(input.password, address));
      if (breached) throw new BreachedPasswordError();
      await assertAddressFree(repos, accountId, address, onPlatform);
      if (await repos.people.userByEmail(address)) {
        throw new ConflictError("That address already has a console login. Invite that person instead.");
      }
      const { id: userId } = await repos.people.createLogin({
        email: address,
        name: shown,
        firstName: names.firstName,
        lastName: names.lastName,
        passwordHash: await hashLogin(password),
        mustChangePassword: requireChange,
      });
      await repos.accounts.addMember({ accountId, userId, role });
      if (Object.keys(profile).length > 0) await repos.people.setProfile(userId, profile);
      const mailbox = {
        ...newMailbox(deps, accountId, userId, address, quotaBytes),
        displayName: shown,
        mustChangePassword: requireChange,
      };
      await repos.mailboxes.insert(mailbox);
      // The worker sets it when it creates the account (`MailServer.ensureMailbox` `initialPasswordHash`).
      await repos.mailboxPasswords.setPending(mailbox.id, await hashMailboxPassword(hasher, password), null);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return {
        result: {
          mailbox: await viewOf(repos, accountId, mailbox),
          userId,
          role,
          password: generate ? password : null,
          requirePasswordChange: requireChange,
        },
        target: { id: mailbox.id, label: address },
        meta: {
          userId,
          role,
          quotaGb: quotaBytes / GB,
          passwordGenerated: generate,
          requirePasswordChange: requireChange,
          // Which optional details were given, never their values (personal data).
          profileFields: Object.keys(profile),
          ...(onPlatform ? { platformAddress: true } : {}),
        },
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Users can't be added while acting as someone.");
  if (out === "email_unverified") throw new EmailUnverifiedError();
  if (out === "role") throw new ForbiddenError("Only an owner can give a new user that role.");
  return out;
}
