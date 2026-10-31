// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor } from "../actor";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { displayName } from "./entity";

/**
 * Names as one source (CLAUDE.md rule 61; 04-data-model.md "Names"; ADR-0014 update 2026-10-31). A person has one
 * name (`auth_user.name`). A mailbox's sender name — "Name" in "Name <address>", the mail server account's description
 * and the name on each of its sending identities — is the mailbox's custom display name when an admin set one, else
 * its person's name, else none. `mailbox.display_name` null means "follow the person" (or, without a person, none).
 */

/** Where a mailbox's sender name comes from. */
export type NameSource = "custom" | "person" | "none";

export type MailboxName = { name: string | null; source: NameSource };

const clean = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

/** The one rule: the custom display name, else the person's name, else none. */
export function mailboxSenderName(
  custom: string | null | undefined,
  personName: string | null | undefined,
): MailboxName {
  const own = clean(custom);
  if (own !== null) return { name: own, source: "custom" };
  const person = clean(personName);
  return person !== null ? { name: person, source: "person" } : { name: null, source: "none" };
}

/** A mailbox's sender name as it stands, reading its person's name (inside the caller's unit of work). */
export async function mailboxNameOf(
  repos: Repositories,
  m: Pick<Mailbox, "userId" | "displayName">,
): Promise<MailboxName> {
  const person = m.userId === null ? null : await repos.suspensions.personInfo(m.userId);
  return mailboxSenderName(m.displayName, person?.name);
}

/**
 * After a person's name changed: queues `mailbox.ensure` for each of their mailboxes (in every account) whose sender
 * name follows them, so the worker writes the new name to the mail server as the account's description. A mailbox
 * being deleted is left alone (its restore queues its own job). Returns how many were queued.
 */
export async function queuePersonNameSync(repos: Repositories, userId: string, now: Date): Promise<number> {
  const mine = await repos.suspensions.mailboxesOf(userId);
  let queued = 0;
  for (const m of mine) {
    if (clean(m.displayName) !== null || m.status === "deleting") continue;
    await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: now });
    queued += 1;
  }
  return queued;
}

/**
 * Whether the person holds a platform role (Global Administrator or another staff role). Their name and photo are
 * theirs to change, never a customer account's: counted like belonging to another account (`other_account`) by every
 * edit rule (`editRefusal`, the webmail's sender name and photo), so the Owner of the one account a staff member is in
 * can't rename them or change their photo.
 */
export async function holdsPlatformRole(repos: Repositories, userId: string): Promise<boolean> {
  return (await repos.access.platformRoles(userId)).length > 0;
}

/** A person's name, by the display-name rules (1–80 characters, the shared name rules); "Enter your name." if empty. */
export function personName(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Enter your name.");
  return displayName(input);
}

// ---- the webmail (Settings → Account → Sender name) ---------------------------------------------------------

/**
 * The sender name a webmail session's own mailbox shows, and whether it may be changed there: only when it follows the
 * mailbox's person and that person is in no account but the mailbox's (the same rule as their photo from the webmail,
 * `avatars/service.ts`): a mailbox password can be reset by the account's admins, so the webmail never changes a name
 * other accounts see too.
 */
export type WebmailSenderName = MailboxName & {
  editable: boolean;
  /** Why it can't be changed here (shown beside it); absent when it can. */
  reason?: string;
};

export const SENDER_NAME_SET_BY_ADMIN = "Set by your admin in the console.";
export const SENDER_NAME_OTHER_ACCOUNT =
  "This is your name in more than one account, so change it from Profile in the console.";
export const SENDER_NAME_NOT_MEMBER =
  "This mailbox's person is no longer in its account, so its name can't be changed here. Ask an admin of the account.";

type Refusal = "admin_set" | "other_account" | "not_member";

const REFUSALS: Record<Refusal, string> = {
  admin_set: SENDER_NAME_SET_BY_ADMIN,
  other_account: SENDER_NAME_OTHER_ACCOUNT,
  not_member: SENDER_NAME_NOT_MEMBER,
};

const norm = (address: string) => address.trim().toLowerCase();

async function webmailMailbox(repos: Repositories, address: string): Promise<Mailbox | null> {
  const key = norm(address);
  if (key.length > 254) return null;
  const found = await repos.webmailSettings.mailboxByAddress(key);
  return found ? repos.mailboxes.get(found.accountId, found.id) : null;
}

async function refusalFor(repos: Repositories, m: Mailbox, name: MailboxName): Promise<Refusal | null> {
  if (m.userId === null || name.source === "custom") return "admin_set";
  const accounts = [...new Set((await repos.access.memberships(m.userId)).map((x) => x.accountId))];
  if (!accounts.includes(m.accountId)) return "not_member";
  // Staff (any platform role) count as being elsewhere too: their name is never changed from a customer mailbox.
  return accounts.length > 1 || (await holdsPlatformRole(repos, m.userId)) ? "other_account" : null;
}

async function senderView(repos: Repositories, m: Mailbox): Promise<WebmailSenderName> {
  const name = await mailboxNameOf(repos, m);
  const refusal = await refusalFor(repos, m, name);
  return { ...name, editable: refusal === null, ...(refusal ? { reason: REFUSALS[refusal] } : {}) };
}

/** The sender name for a webmail session's own mailbox (by its address); null for an address we don't hold. */
export async function webmailSenderName(deps: Deps, address: string): Promise<WebmailSenderName | null> {
  return deps.uow.run(async (repos) => {
    const m = await webmailMailbox(repos, address);
    return m ? senderView(repos, m) : null;
  });
}

/**
 * What a webmail session's own mailbox sends as (by its address; null for an address we don't hold): its sender name,
 * and the addresses of its masked aliases (lower-cased), which send with no name at all — a masked alias exists so a
 * website can't tie it to the person, and a name would (ADR-0014 update 2026-10-31). Plain aliases send with the name.
 */
export async function webmailSendingNames(
  deps: Deps,
  address: string,
): Promise<{ name: string | null; masked: string[] } | null> {
  return deps.uow.run(async (repos) => {
    const m = await webmailMailbox(repos, address);
    if (!m) return null;
    const name = await mailboxNameOf(repos, m);
    const aliases = await repos.aliases.listByAccount(m.accountId);
    const masked = aliases.filter((a) => a.mailboxId === m.id && a.kind === "masked").map((a) => norm(a.address));
    return { name: name.name, masked };
  });
}

/**
 * The webmail's "Sender name" for its own mailbox: changes the mailbox person's name — the one source, so the console,
 * People and every mailbox of theirs that follows it change too (`queuePersonNameSync`). Audited like their own
 * Profile edit (`account.profile_changed`, fields `name`, `via: webmail`; never the name). Refused (403, audited as
 * denied) when an admin set the mailbox's name, the mailbox has no person, or the person is in another account too.
 * The actor is the mailbox itself, as for the other webmail settings: the session proved its password.
 */
export async function setWebmailSenderName(
  deps: Deps,
  address: string,
  input: { name?: unknown },
  req: RequestMeta,
): Promise<WebmailSenderName> {
  const actor: Actor = { kind: "system", name: norm(address) };
  const m = await deps.uow.run((r) => webmailMailbox(r, address));
  if (!m) throw new NotFoundError();
  const person = m.userId;
  const out = await mutation<WebmailSenderName | Refusal>(
    deps,
    actor,
    req,
    person !== null
      ? {
          action: "account.profile_changed",
          permission: "self.profile.manage",
          accountId: m.accountId,
          target: { type: "person", id: person, label: null },
        }
      : {
          action: "mailbox.renamed",
          permission: "mailbox.read",
          accountId: m.accountId,
          target: { type: "mailbox", id: m.id, label: m.address },
        },
    async (repos) => {
      const cur = await repos.mailboxes.get(m.accountId, m.id);
      if (cur?.userId !== person) throw new ConflictError("This mailbox changed meanwhile. Try again.");
      const before = await mailboxNameOf(repos, cur);
      const label = person ? ((await repos.suspensions.personInfo(person))?.email ?? m.address) : m.address;
      const refusal = await refusalFor(repos, cur, before);
      if (refusal !== null || person === null) {
        const code = refusal ?? "admin_set";
        return { result: code, target: { label }, meta: { via: "webmail" }, denied: { code } };
      }
      const name = personName(input.name);
      const changed = name !== before.name;
      if (changed) {
        await repos.people.setName(person, name);
        await queuePersonNameSync(repos, person, deps.clock.now());
      }
      return {
        result: await senderView(repos, { ...cur, userId: person }),
        target: { label },
        // Which field changed, never its value (personal data).
        meta: { fields: changed ? ["name"] : [], self: true, via: "webmail" },
      };
    },
  );
  if (typeof out === "string") throw new ForbiddenError(REFUSALS[out]);
  return out;
}
