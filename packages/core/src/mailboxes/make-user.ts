// SPDX-License-Identifier: AGPL-3.0-only
import { generateMailboxPassword } from "@anhourmail/shared/security";
import type { AccountRole } from "@anhourmail/shared/rbac";

import type { Actor } from "../actor";
import { ConflictError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { mutation, type MutationOutcome } from "../mutation";
import { displayName, isAccountRole, loginNames, profileDetails } from "../people/entity";
import { assertRoom, grantableRoles } from "../people/service";
import type { Deps, RequestMeta } from "../ports";
import { hashMailboxPassword, type PasswordHasher } from "./password-hash";
import { type MailboxView, viewOf } from "./service";

export type MakeUserInput = {
  firstName?: unknown;
  lastName?: unknown;
  /** Defaults to the mailbox's display name when blank. */
  displayName?: unknown;
  role?: unknown;
  /** Optional profile details (`profileDetails`). */
  profile?: unknown;
};

export type MadeUser = {
  mailbox: MailboxView;
  userId: string;
  role: AccountRole;
  /** The generated password, shown to the admin once. Never stored, logged or audited. */
  password: string;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type Refusal = "act_as" | "role" | "step_up_required";

/**
 * "Make this a user" (a person-less mailbox's Overview): turns an existing unassigned mailbox, like one added as a
 * shared address, into a person who signs in with it — the same result as "Add a user" (`addUser`), without creating
 * a mailbox. In one audited unit of work: a console login whose sign-in email is the mailbox address (verified: the
 * account controls it), the membership with the chosen role, the optional profile details, the owner link, the display
 * name, and a new generated password for both the console (salted argon2id, `hashLogin`) and the mailbox (its own
 * argon2id hash, applied by the worker's `mailbox.password` job), with the first-sign-in change required in both.
 * The mailbox's app passwords are revoked (`app_password.revoke`), and its webmail sessions and tokens end when the new
 * password reaches the mail server, so nobody who used the shared address keeps a way in. The password is returned
 * once and never stored, queued, logged or audited (rule 23).
 *
 * Same gate as `addUser`: `mailbox.manage` (403 without it, 404 for another account's id or mailbox) and a role the
 * actor may grant (`grantableRoles`; 403 audited as denied). Refused during a staff act-as session, on plans without
 * people, at the people ceiling, when the address already has a console login, and for a mailbox that already belongs
 * to someone or isn't active on the mail server. Because it replaces the password of a mailbox that is already in
 * use, it also needs a recent step-up on this console session, like setting a mailbox password (403
 * `step_up_required`). Audited as `mailbox.made_user` with the role and which profile fields were given, never values.
 */
export async function makeMailboxUser(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: MakeUserInput,
  session: { sessionId: string | null },
  req: RequestMeta,
  hasher: PasswordHasher,
  hashLogin: (password: string) => Promise<string>,
): Promise<MadeUser> {
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "mailbox.made_user",
      permission: "mailbox.manage",
      accountId,
      target: { type: "mailbox", id: mailboxId },
    },
    async (repos): Promise<MutationOutcome<MadeUser | Refusal>> => {
      const m = isId(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
      if (!m) throw new NotFoundError();
      const refuse = (code: Refusal, meta?: Record<string, unknown>) => ({
        result: code,
        target: { label: m.address },
        ...(meta ? { meta } : {}),
        denied: { code: code === "role" ? "forbidden" : code },
      });
      if (actor.kind !== "user") throw new ForbiddenError();
      if (actor.actingAs) return refuse("act_as");
      const role = input.role === undefined || input.role === null || input.role === "" ? "member" : input.role;
      if (!isAccountRole(role)) throw new ValidationError("Choose a role.");
      if (!grantableRoles(actor, accountId).includes(role)) return refuse("role", { role });
      if (m.userId !== null) throw new ConflictError("This mailbox already belongs to someone.");
      if (m.status === "deleting") throw new ConflictError("This mailbox is being deleted. Restore it first.");
      if (m.status !== "active" || m.stalwartId === null) {
        throw new ConflictError("This mailbox isn't active on the mail server. Try again once it is.");
      }
      const names = loginNames(input);
      const rawShown = typeof input.displayName === "string" ? input.displayName.trim() : "";
      const shown = displayName(rawShown === "" ? (m.displayName ?? names.name) : rawShown);
      const profile = profileDetails(input.profile);
      // The step-up comes before anything is looked up about the address (whether it has a console login).
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return refuse("step_up_required");
      }
      await repos.accounts.lock(accountId); // the people ceiling holds under concurrent creates
      await assertRoom(repos, accountId, deps.clock.now());
      if (await repos.people.userByEmail(m.address)) {
        throw new ConflictError("That address already has a console login. Invite that person instead.");
      }
      const password = generateMailboxPassword();
      const { id: userId } = await repos.people.createLogin({
        email: m.address,
        name: shown,
        firstName: names.firstName,
        lastName: names.lastName,
        passwordHash: await hashLogin(password),
        mustChangePassword: true,
      });
      await repos.accounts.addMember({ accountId, userId, role });
      if (Object.keys(profile).length > 0) await repos.people.setProfile(userId, profile);
      if (!(await repos.mailboxes.assignOwner(m.id, userId))) {
        throw new ConflictError("This mailbox changed while you were working on it. Reload and try again.");
      }
      await repos.mailboxes.setDisplayName(m.id, shown);
      await repos.mailboxes.setPasswordChangeRequired(m.id, true);
      // The new mailbox password, for the worker (with the grant the management proxy needs for a replacement).
      const phc = await hashMailboxPassword(hasher, password);
      await repos.mailboxPasswords.setPending(
        m.id,
        phc,
        hasher.grant?.({ externalId: m.stalwartId, passwordHash: phc }) ?? null,
      );
      const now = deps.clock.now();
      // The new password ends every webmail session and OAuth token of the mailbox (the mail server derives them from
      // the password); app passwords don't depend on it, so the ones made for the shared address go too: whoever made
      // them keeps no way in once it belongs to this person.
      const revoked = await repos.appPasswords.markRevoking(m.id, null);
      if (revoked.length > 0) {
        await repos.provisioning.enqueue({ kind: "app_password.revoke", subjectId: m.id, runAfter: now });
      }
      await repos.provisioning.enqueue({ kind: "mailbox.password", subjectId: m.id, runAfter: now });
      // The display name becomes the mail server account's description.
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: now });
      return {
        result: {
          mailbox: await viewOf(repos, accountId, { ...m, userId, displayName: shown, mustChangePassword: true }),
          userId,
          role,
          password,
        },
        target: { label: m.address },
        meta: {
          userId,
          role,
          // Which optional details were given, never their values (personal data).
          profileFields: Object.keys(profile),
          appPasswordsRevoked: revoked.length,
        },
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Users can't be added while acting as someone.");
  if (out === "role") throw new ForbiddenError("Only an owner can give a new user that role.");
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}
