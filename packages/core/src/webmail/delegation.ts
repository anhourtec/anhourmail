// SPDX-License-Identifier: AGPL-3.0-only
import { DELEGATED_MAILBOXES_PER_PERSON, PLANS } from "@anhourmail/shared/plans";

import type { UserActor } from "../actor";
import type { DelegationRight } from "../delegation/entity";
import { DelegatedMailboxRefusedError, ForbiddenError, NotFoundError, TryAgainError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { WebmailAccess } from "./access";

/**
 * Delegated mailboxes in the webmail (ADR-0026 §6, §7). A person given "Read and manage" (or a send right) on another
 * mailbox of their account opens it in their own webmail session, without its password: the web app mints a throwaway
 * credential on that mailbox, exchanges it once for that mailbox's tokens and destroys it (the console handoff's
 * mechanism, ADR-0024), and seals the tokens into the delegate's session. The grant table is the authorisation, checked:
 *
 *   - when listing what the session may open (`delegatedMailboxesFor`, the "Shared with you" list; no tokens);
 *   - when opening one (`openDelegatedMailbox`, audited `delegation.mailbox_opened`, refusals included);
 *   - on every request that acts on an opened one (`DelegationGate`, "has the right" cached ≤ 10 s, "no right" never).
 *
 * Each check is "now": the person is still a member and not suspended, the account's plan has `delegation`, they hold
 * the right on the mailbox, the mailbox is active and passes the webmail access gate, the delegate's own mailbox (the one
 * whose sign-in this is, `via`) is still theirs and usable, and the console session a handoff-born webmail session came
 * from has no act-as open (ADR-0023). Every refusal looks the same to the person (404 "You don't have access to this
 * mailbox."), so it never says whether an address exists or belongs to another account (rule 25).
 */

/** What an action on a delegated mailbox needs: reading and managing, or sending from it (either send right). */
export type DelegationNeed = "full_access" | "send";

/** One mailbox the session's people may open or send from (`delegatedMailboxesFor`). */
export type DelegatedMailbox = {
  accountId: string;
  mailboxId: string;
  /** The delegated mailbox's address (lowercase). */
  address: string;
  /** The person holding the rights (a member of `accountId`). */
  granteeUserId: string;
  /** The delegate's own signed-in mailbox the rights come through (lowercase). */
  via: string;
  rights: DelegationRight[];
};

/** Whether a mailbox may use the webmail right now (uncached: the webmail access gate's own answer). */
export type DelegationAccess = { state(address: string): Promise<WebmailAccess> };

/** A handoff-born webmail session's console session (ADR-0024): act-as there refuses delegated access too. */
export type ConsoleBinding = { userId: string; sessionId: string };

/** One delegated entry of a webmail session, as the gate checks it. */
export type DelegatedEntry = {
  mailboxId: string;
  granteeUserId: string;
  via: string;
  need: DelegationNeed;
  console?: ConsoleBinding | null;
};

/** The mailbox to open, for the caller's `open`. */
export type DelegatedTarget = {
  accountId: string;
  mailboxId: string;
  address: string;
  externalId: string;
  granteeUserId: string;
  via: string;
};

type Refusal = "not_granted" | "mailbox_unavailable" | "act_as";

const lower = (a: string): string => a.trim().toLowerCase();

const grants = (rights: readonly DelegationRight[], need: DelegationNeed): boolean =>
  need === "full_access"
    ? rights.includes("full_access")
    : rights.includes("send_as") || rights.includes("send_on_behalf");

/** The delegate's own mailbox at `address`: theirs (it has a person), active. Null otherwise. */
async function ownMailbox(r: Repositories, address: string): Promise<Mailbox | null> {
  const found = await r.webmailSettings.mailboxByAddress(lower(address));
  if (!found) return null;
  const m = await r.mailboxes.get(found.accountId, found.id);
  return m?.userId && m.status === "active" ? m : null;
}

/** Whether `userId` may use delegation in `accountId` now: a member, not suspended, the plan has it, account usable. */
async function personMayDelegate(r: Repositories, accountId: string, userId: string): Promise<boolean> {
  const account = await r.accounts.get(accountId);
  if (!account || !PLANS[account.plan].delegation) return false;
  const member = (await r.people.list(accountId)).find((p) => p.userId === userId);
  if (!member || member.suspended) return false;
  if ((await r.suspensions.suspendedAccountsOf(userId)).includes(accountId)) return false;
  return !(await r.dataLifecycle.deletingAccountsOf(userId)).includes(accountId);
}

const usable = (m: Mailbox): boolean => m.status === "active" && m.stalwartId !== null;

/**
 * The delegated mailboxes the people behind a webmail session's own mailboxes may use now (auto-mapping, ADR-0026 §6):
 * `sessionOwners` are the session's own signed-in addresses (never delegated entries), the active one first. For each,
 * its person (`mailbox.user_id`; a shared mailbox signed in by password has none and maps nothing), then every mailbox
 * of that account they hold a right on — only when the account's plan has delegation, they are still a member and not
 * suspended, and the mailbox is active. No tokens, nothing written (no audit). At most `DELEGATED_MAILBOXES_PER_PERSON`
 * per person, by address.
 */
export async function delegatedMailboxesFor(deps: Deps, sessionOwners: readonly string[]): Promise<DelegatedMailbox[]> {
  const owners = [...new Set(sessionOwners.map(lower))].slice(0, 10);
  return deps.uow.run(async (r) => {
    const people = new Map<string, { accountId: string; userId: string; via: string }>();
    for (const address of owners) {
      const own = await ownMailbox(r, address);
      if (!own?.userId) continue;
      const key = `${own.accountId} ${own.userId}`;
      if (!people.has(key)) people.set(key, { accountId: own.accountId, userId: own.userId, via: own.address });
    }
    const out: DelegatedMailbox[] = [];
    const seen = new Set<string>();
    for (const p of people.values()) {
      if (!(await personMayDelegate(r, p.accountId, p.userId))) continue;
      const byMailbox = new Map<string, DelegationRight[]>();
      for (const g of await r.delegation.listForGrantee(p.accountId, p.userId)) {
        byMailbox.set(g.mailboxId, [...(byMailbox.get(g.mailboxId) ?? []), g.right]);
      }
      const mine: DelegatedMailbox[] = [];
      for (const [mailboxId, rights] of byMailbox) {
        const m = await r.mailboxes.get(p.accountId, mailboxId);
        if (!m || !usable(m) || m.userId === p.userId || seen.has(m.id)) continue;
        seen.add(m.id);
        mine.push({
          accountId: p.accountId,
          mailboxId: m.id,
          address: lower(m.address),
          granteeUserId: p.userId,
          via: lower(p.via),
          rights,
        });
      }
      out.push(...mine.sort((a, b) => a.address.localeCompare(b.address)).slice(0, DELEGATED_MAILBOXES_PER_PERSON));
    }
    return out;
  });
}

type Checked =
  | { ok: true; mailbox: Mailbox; rights: DelegationRight[] }
  | { ok: false; code: Refusal; mailbox: Mailbox | null; meta?: Record<string, unknown> };

/**
 * Every "now" check for one delegated mailbox (both the open and the gate): see the module comment. `mailbox` is the
 * target when it is in the delegate's account (for the audit target), else null. Read-only.
 */
async function check(
  r: Repositories,
  access: DelegationAccess,
  input: { accountId: string; mailbox: Mailbox | null; granteeUserId: string; via: string; need: DelegationNeed },
  now: Date,
  console: ConsoleBinding | null | undefined,
): Promise<Checked> {
  const { accountId, mailbox, granteeUserId } = input;
  if (console && (await r.actAs.active(console.userId, console.sessionId, now))) {
    return { ok: false, code: "act_as", mailbox: null };
  }
  const via = await ownMailbox(r, input.via);
  if (via?.userId !== granteeUserId || via.accountId !== accountId) {
    return { ok: false, code: "not_granted", mailbox: null, meta: { reason: "own_mailbox" } };
  }
  if (mailbox?.accountId !== accountId || mailbox.userId === granteeUserId) {
    return { ok: false, code: "not_granted", mailbox: null };
  }
  if (!(await personMayDelegate(r, accountId, granteeUserId))) {
    return { ok: false, code: "not_granted", mailbox, meta: { reason: "person_or_plan" } };
  }
  const rights = await r.delegation.rightsOf(accountId, mailbox.id, granteeUserId);
  if (!grants(rights, input.need)) return { ok: false, code: "not_granted", mailbox };
  // Only now, for someone who holds the right, does the mailbox's own state matter.
  if (!usable(mailbox)) return { ok: false, code: "mailbox_unavailable", mailbox, meta: { state: mailbox.status } };
  const state = await access.state(mailbox.address);
  if (state !== "ok") return { ok: false, code: "mailbox_unavailable", mailbox, meta: { state } };
  const own = await access.state(via.address);
  if (own !== "ok") return { ok: false, code: "mailbox_unavailable", mailbox, meta: { state: own, own: true } };
  return { ok: true, mailbox, rights };
}

/**
 * Whether one opened delegated entry may still be used now (the `DelegationGate`'s lookup). Read-only; false for any
 * refusal (the caller drops the entry and answers 404).
 */
export function delegationCheck(deps: Deps, access: DelegationAccess): (entry: DelegatedEntry) => Promise<boolean> {
  return (entry) =>
    deps.uow.run(async (r) => {
      const via = await ownMailbox(r, entry.via);
      if (!via) return false;
      const mailbox = await r.mailboxes.get(via.accountId, entry.mailboxId);
      const out = await check(
        r,
        access,
        { accountId: via.accountId, mailbox, granteeUserId: entry.granteeUserId, via: entry.via, need: entry.need },
        deps.clock.now(),
        entry.console,
      );
      return out.ok;
    });
}

/**
 * The delegation check on every request acting on a delegated entry (ADR-0026 §6, like `PasswordChangeGate`): "has the
 * right" is cached for at most `ttlMs` (≤ 10 s) per (session, mailbox, need); "no right" is never cached, so a revoke,
 * a removal, a suspension or a plan downgrade stops use within 10 s. Read-only (no audit). Failures throw (the caller
 * refuses the request without dropping anything).
 */
export class DelegationGate {
  readonly #check: (entry: DelegatedEntry) => Promise<boolean>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #ok = new Map<string, number>();

  constructor(check: (entry: DelegatedEntry) => Promise<boolean>, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#check = check;
    this.#ttlMs = Math.min(opts.ttlMs ?? 10_000, 10_000);
    this.#now = opts.now ?? Date.now;
  }

  /** `session` is a stable key for the webmail session (a hash of its id, never the id itself). */
  async allowed(session: string, entry: DelegatedEntry): Promise<boolean> {
    const key = `${session}\0${entry.mailboxId}\0${entry.granteeUserId}\0${lower(entry.via)}\0${entry.need}`;
    const now = this.#now();
    const until = this.#ok.get(key);
    if (until !== undefined && until > now) return true;
    const ok = await this.#check(entry);
    if (!ok) {
      this.#ok.delete(key);
      return false;
    }
    if (this.#ok.size > 10_000) this.#ok.clear();
    this.#ok.set(key, now + this.#ttlMs);
    return true;
  }

  /** Drops every cached answer for a session (signed out, or an entry dropped). */
  forget(session: string): void {
    for (const key of this.#ok.keys()) if (key.startsWith(`${session}\0`)) this.#ok.delete(key);
  }
}

/**
 * The open's credential was refused because the mailbox's reserved slot was taken (a concurrent open or handoff, or a
 * leftover): thrown by the caller's `open`; the open retries once, then answers 503 "Try again".
 */
export class CredentialSlotTakenError extends Error {
  override readonly name = "CredentialSlotTakenError";
}

/** The person behind the delegate's own mailbox, as an actor for the audit entry (never a console session's roles). */
async function delegateActor(r: Repositories, userId: string, email: string): Promise<UserActor> {
  const memberships = await r.access.memberships(userId);
  const suspended = await r.access.isSuspended(userId);
  const suspendedAccountIds = await r.suspensions.suspendedAccountsOf(userId);
  return {
    kind: "user",
    userId,
    email,
    platformRoles: [],
    memberships,
    suspended,
    ...(suspendedAccountIds.length > 0 ? { suspendedAccountIds } : {}),
  };
}

/**
 * Opens a delegated mailbox for a webmail session (ADR-0026 §6, "Opening one"; also the server side of **Open another
 * mailbox**). `owners` are the session's own signed-in addresses (active first); `address` is the mailbox to open, as
 * typed or chosen. The person is the owner whose account holds `address` and who holds the right; refusals are audited
 * in the first owner's account (the person's own), never in another account's.
 *
 * Inside one unit of work: act-as refused first (403); the account lock (a removal and an open serialise); every check
 * of `DelegationGate` now; then the mailbox's credential lock and `open` (the caller mints a throwaway credential,
 * exchanges it once with the person's client address forwarded and destroys it, and returns the tokens with the
 * mail server's session `username`), retried once when the credential slot was taken, else 503. The username must be
 * the mailbox's address. Audited `delegation.mailbox_opened`: success, denied `not_granted` / `mailbox_unavailable` /
 * `act_as`, failed when the mail server refused. Every refusal but act-as is the same `DelegatedMailboxRefusedError`.
 * Tokens are never returned in the audit or logged.
 */
export async function openDelegatedMailbox<T extends { username: string }>(
  deps: Deps,
  access: DelegationAccess,
  input: {
    owners: readonly string[];
    address: string;
    need?: DelegationNeed;
    console?: ConsoleBinding | null;
  },
  open: (target: DelegatedTarget) => Promise<T>,
  req: RequestMeta,
): Promise<{ value: T; mailbox: DelegatedMailbox }> {
  const need = input.need ?? "full_access";
  const address = lower(input.address);
  const now = deps.clock.now();
  // Who is asking, and where the target is — read before the audited unit of work, which re-checks all of it.
  const resolved = await deps.uow.run(async (r) => {
    const owners: Mailbox[] = [];
    for (const a of input.owners.slice(0, 10)) {
      const m = await ownMailbox(r, a);
      if (m) owners.push(m);
    }
    const found = address.length <= 254 ? await r.webmailSettings.mailboxByAddress(address) : null;
    const target = found ? await r.mailboxes.get(found.accountId, found.id) : null;
    // The person whose account holds the mailbox and who holds the right; else someone in that account; else the
    // active mailbox's person (the refusal is then recorded in their own account only).
    const local = target ? owners.filter((o) => o.accountId === target.accountId) : [];
    let chosen = local[0] ?? owners[0] ?? null;
    for (const o of target ? local : []) {
      if (grants(await r.delegation.rightsOf(o.accountId, target?.id ?? "", o.userId ?? ""), need)) {
        chosen = o;
        break;
      }
    }
    if (!chosen?.userId) return null;
    const member = (await r.people.list(chosen.accountId)).find((p) => p.userId === chosen.userId);
    const actor = await delegateActor(r, chosen.userId, member?.email ?? "");
    return { via: chosen, actor, target: target?.accountId === chosen.accountId ? target : null };
  });
  // No own mailbox with a person behind this session: nobody to audit for, and nothing to open.
  if (!resolved) throw new DelegatedMailboxRefusedError();
  const { via, actor } = resolved;
  const accountId = via.accountId;
  const granteeUserId = via.userId ?? "";

  let out: { value: T; mailbox: DelegatedMailbox } | Refusal;
  try {
    out = await mutation(
      deps,
      actor,
      req,
      {
        action: "delegation.mailbox_opened",
        // The grant itself is the authorisation (ADR-0026 §4: no permission for using one); the matrix check here is the
        // self-level one (a person, not suspended). Membership, the right and the plan are checked below, now.
        permission: "self.profile.read",
        accountId,
        target: { type: "mailbox", id: resolved.target?.id ?? null },
      },
      async (repos): Promise<MutationOutcome<{ value: T; mailbox: DelegatedMailbox } | Refusal>> => {
        const refuse = (code: Refusal, mailbox: Mailbox | null, meta: Record<string, unknown> = {}) => ({
          result: code,
          target: { id: mailbox?.id ?? null, label: mailbox?.address ?? null },
          denied: { code },
          meta: { need, ...meta },
        });
        // Staff acting as someone never reach mail (ADR-0023): before anything is looked up.
        if (input.console && (await repos.actAs.active(input.console.userId, input.console.sessionId, now))) {
          return refuse("act_as", null);
        }
        // The same lock a removal holds: a person removed meanwhile is refused, not given tokens.
        await repos.accounts.lock(accountId);
        const mailbox = resolved.target ? await repos.mailboxes.get(accountId, resolved.target.id) : null;
        const checked = await check(
          repos,
          access,
          { accountId, mailbox, granteeUserId, via: via.address, need },
          now,
          input.console,
        );
        if (!checked.ok) return refuse(checked.code, checked.mailbox, checked.meta);
        const m = checked.mailbox;
        const externalId = m.stalwartId ?? "";
        // Minted, used and destroyed under the mailbox's credential lock (ADR-0024 decision 6), in the reserved slot.
        await repos.appPasswords.lockCredentials(m.id);
        const target: DelegatedTarget = {
          accountId,
          mailboxId: m.id,
          address: lower(m.address),
          externalId,
          granteeUserId,
          via: lower(via.address),
        };
        let value: T;
        try {
          value = await open(target);
        } catch (err) {
          if (!(err instanceof CredentialSlotTakenError)) throw err;
          try {
            value = await open(target);
          } catch (again) {
            if (again instanceof CredentialSlotTakenError) throw new TryAgainError();
            throw again;
          }
        }
        if (lower(value.username) !== target.address) throw new TryAgainError("The mail server named another mailbox.");
        return {
          result: {
            value,
            mailbox: {
              accountId,
              mailboxId: m.id,
              address: target.address,
              granteeUserId,
              via: target.via,
              rights: checked.rights,
            },
          },
          target: { id: m.id, label: m.address },
          meta: { need },
        };
      },
    );
  } catch (err) {
    // The matrix's own refusals (a suspended person or account) were audited by `mutation`; they look like any other.
    if (err instanceof ForbiddenError || err instanceof NotFoundError) throw new DelegatedMailboxRefusedError();
    throw err;
  }
  if (out === "act_as") throw new ForbiddenError("Other mailboxes can't be opened while staff act as someone.");
  if (typeof out === "string") throw new DelegatedMailboxRefusedError();
  return out;
}

/** Which send right a delegated send uses (ADR-0026 §6): mail as the mailbox, or "delegate on behalf of mailbox". */
export type DelegatedSendMode = "send_as" | "send_on_behalf";

/** The send right used from these rights: send as wins when both are held; null without either. */
export function sendMode(rights: readonly DelegationRight[]): DelegatedSendMode | null {
  if (rights.includes("send_as")) return "send_as";
  return rights.includes("send_on_behalf") ? "send_on_behalf" : null;
}

/** A delegated send the grant table allowed just now (`authorizeDelegatedSend`). */
export type DelegatedSendAuthorization = {
  mode: DelegatedSendMode;
  accountId: string;
  mailboxId: string;
  /** The mailbox sent from (lowercase): the From, the envelope sender. */
  address: string;
  /** The delegate's own address (lowercase): the Sender of a send on behalf. */
  via: string;
};

/** A delegated entry being sent from, and what the audit may record about the message (a count, never addresses). */
export type DelegatedSendInput = {
  mailboxId: string;
  granteeUserId: string;
  via: string;
  console?: ConsoleBinding | null;
  /** Envelope recipients (deduplicated): only the count is recorded (rule 24). */
  recipientCount: number;
};

type SendRefusal = Refusal;

const sendAction = (mode: DelegatedSendMode) =>
  mode === "send_as" ? ("delegation.sent_as" as const) : ("delegation.sent_on_behalf" as const);

/**
 * The right to send from a delegated mailbox, checked **now** (uncached, never a page-load answer) immediately before
 * the submission, and audited before anything is submitted (ADR-0026 §6 and §8, slice 13 requirement 2): if the audit
 * append fails, the caller sends nothing.
 *
 * Inside one unit of work: act-as refused first; the account lock (a removal or revoke and a send serialise); every
 * check of `DelegationGate` for a send right (the person still a member, not suspended, the plan, the right, the
 * mailbox active and usable, their own mailbox still theirs); then the right used — send as wins over send on behalf.
 * Audited `delegation.sent_as` / `delegation.sent_on_behalf` in the account (the delegate's and the mailbox's), actor
 * = the delegate, target = the mailbox, meta `mailboxId`, `recipientCount` and `need` only — never addresses, a
 * subject or content (rule 24). Refusals are `denied` (`not_granted`, `mailbox_unavailable`, `act_as`) and answer
 * like the gate (404; act-as 403); a right that changed between the read and the lock is `failed` ("try again").
 */
export async function authorizeDelegatedSend(
  deps: Deps,
  access: DelegationAccess,
  input: DelegatedSendInput,
  req: RequestMeta,
): Promise<DelegatedSendAuthorization> {
  const now = deps.clock.now();
  const pre = await deps.uow.run(async (r) => {
    const via = await ownMailbox(r, input.via);
    if (!via?.userId || via.userId !== input.granteeUserId) return null;
    const mailbox = await r.mailboxes.get(via.accountId, input.mailboxId);
    const rights = mailbox ? await r.delegation.rightsOf(via.accountId, mailbox.id, input.granteeUserId) : [];
    const member = (await r.people.list(via.accountId)).find((p) => p.userId === via.userId);
    const actor = await delegateActor(r, via.userId, member?.email ?? "");
    return { via, mailbox, mode: sendMode(rights) ?? "send_as", actor };
  });
  if (!pre) throw new DelegatedMailboxRefusedError();
  const accountId = pre.via.accountId;
  const meta = { mailboxId: input.mailboxId, recipientCount: input.recipientCount, need: "send" as const };
  let out: DelegatedSendAuthorization | SendRefusal;
  try {
    out = await mutation(
      deps,
      pre.actor,
      req,
      {
        action: sendAction(pre.mode),
        // As for opening one (ADR-0026 §4): the grant is the authorisation, checked below; the matrix check is the
        // self-level one (a person, not suspended).
        permission: "self.profile.read",
        accountId,
        target: { type: "mailbox", id: pre.mailbox?.id ?? null },
      },
      async (repos): Promise<MutationOutcome<DelegatedSendAuthorization | SendRefusal>> => {
        const refuse = (code: SendRefusal, mailbox: Mailbox | null, extra: Record<string, unknown> = {}) => ({
          result: code,
          target: { id: mailbox?.id ?? null, label: mailbox?.address ?? null },
          denied: { code },
          meta: { ...meta, ...extra },
        });
        if (input.console && (await repos.actAs.active(input.console.userId, input.console.sessionId, now))) {
          return refuse("act_as", null);
        }
        await repos.accounts.lock(accountId);
        const mailbox = await repos.mailboxes.get(accountId, input.mailboxId);
        const checked = await check(
          repos,
          access,
          { accountId, mailbox, granteeUserId: input.granteeUserId, via: input.via, need: "send" },
          now,
          input.console,
        );
        if (!checked.ok) return refuse(checked.code, checked.mailbox, checked.meta);
        const mode = sendMode(checked.rights);
        // Changed between the read above and the lock (a grant or revoke just committed): recorded as failed.
        if (mode !== pre.mode) throw new TryAgainError("Your sending rights for this mailbox changed. Try again.");
        return {
          result: {
            mode,
            accountId,
            mailboxId: checked.mailbox.id,
            address: lower(checked.mailbox.address),
            via: lower(input.via),
          },
          target: { id: checked.mailbox.id, label: checked.mailbox.address },
          meta,
        };
      },
    );
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) throw new DelegatedMailboxRefusedError();
    throw err;
  }
  if (out === "act_as") throw new ForbiddenError("Other mailboxes can't be used while staff act as someone.");
  if (typeof out === "string") throw new DelegatedMailboxRefusedError();
  return out;
}

/**
 * The send right used now, uncached and read-only (no lock, no audit): the last check right before the submission, after
 * `authorizeDelegatedSend` was audited and the attachments copied. Null for any refusal (the caller sends nothing and
 * records `delegation.send_failed`).
 */
export async function delegatedSendCheck(
  deps: Deps,
  access: DelegationAccess,
  input: Omit<DelegatedSendInput, "recipientCount">,
): Promise<DelegatedSendMode | null> {
  return deps.uow.run(async (r) => {
    const via = await ownMailbox(r, input.via);
    if (!via) return null;
    const mailbox = await r.mailboxes.get(via.accountId, input.mailboxId);
    const out = await check(
      r,
      access,
      { accountId: via.accountId, mailbox, granteeUserId: input.granteeUserId, via: input.via, need: "send" },
      deps.clock.now(),
      input.console,
    );
    return out.ok ? sendMode(out.rights) : null;
  });
}

/**
 * What happened to a delegated send after its `delegation.sent_*` entry: undone in the hold, never submitted, or sent
 * but its temporary tagged copy couldn't be removed (twice) — the tag in it expires within minutes.
 */
export type DelegatedSendOutcome =
  { kind: "cancelled" } | { kind: "failed"; reason: string } | { kind: "tagged_copy_left" };

const OUTCOME_ACTION = {
  cancelled: "delegation.send_cancelled",
  failed: "delegation.send_failed",
  tagged_copy_left: "delegation.tagged_copy_left",
} as const;

/**
 * Records what became of a delegated send after it was audited as sent (ADR-0026 §6): `delegation.send_cancelled` (an
 * undo in the hold cancelled it at the mail server) or `delegation.send_failed` (nothing was submitted after all: the
 * mail server refused or couldn't be reached, the quota or the right refused, so a `sent_*` row with no submission is
 * visible; meta `reason`, a short code) or `delegation.tagged_copy_left` (sent, but the temporary copy holding the tag
 * couldn't be destroyed; it is useless once its expiry passes). Actor = the delegate, target = the mailbox, meta `mailboxId`. Refuses (404) a
 * delegate no longer behind their own mailbox or a mailbox outside their account; it refuses nothing else (the right
 * may be gone by now: recording that a send was stopped is never withheld).
 */
export async function recordDelegatedSendOutcome(
  deps: Deps,
  input: { mailboxId: string; granteeUserId: string; via: string },
  outcome: DelegatedSendOutcome,
  req: RequestMeta,
): Promise<void> {
  const pre = await deps.uow.run(async (r) => {
    const via = await ownMailbox(r, input.via);
    if (!via?.userId || via.userId !== input.granteeUserId) return null;
    const mailbox = await r.mailboxes.get(via.accountId, input.mailboxId);
    const member = (await r.people.list(via.accountId)).find((p) => p.userId === via.userId);
    return { via, mailbox, actor: await delegateActor(r, via.userId, member?.email ?? "") };
  });
  if (!pre?.mailbox) throw new DelegatedMailboxRefusedError();
  const mailbox = pre.mailbox;
  const meta =
    outcome.kind === "failed"
      ? {
          mailboxId: mailbox.id,
          reason: outcome.reason
            .toLowerCase()
            .replace(/[^a-z_]/g, "")
            .slice(0, 40),
        }
      : { mailboxId: mailbox.id };
  await mutation(
    deps,
    pre.actor,
    req,
    {
      action: OUTCOME_ACTION[outcome.kind],
      permission: "self.profile.read",
      accountId: pre.via.accountId,
      target: { type: "mailbox", id: mailbox.id },
    },
    async () => ({ result: undefined, target: { id: mailbox.id, label: mailbox.address }, meta }),
  );
}

/** A delegated send undone in its hold (`recordDelegatedSendOutcome` with `cancelled`). */
export function recordDelegatedSendCancelled(
  deps: Deps,
  input: { mailboxId: string; granteeUserId: string; via: string },
  req: RequestMeta,
): Promise<void> {
  return recordDelegatedSendOutcome(deps, input, { kind: "cancelled" }, req);
}
