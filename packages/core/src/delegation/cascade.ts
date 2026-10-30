// SPDX-License-Identifier: AGPL-3.0-only
import { maskEmail } from "../audit/record";
import type { AuditAlso } from "../mutation";
import type { Repositories } from "../ports";
import type { DelegationGrant, DelegationRevokeReason, DelegationRight } from "./entity";

/**
 * Grant bookkeeping shared by every path that adds or removes grants (ADR-0026 §7): the delegation batch, removing a
 * person, deleting or purging a mailbox, "Make this a user" and "Convert to shared mailbox". Each grant or revoke is its
 * own audit entry (`MutationOutcome.also`), written in the mailbox's account log in the same unit of work as the change
 * that caused it, so the account's admins see every one. Entries name the person by id and a masked address, never
 * anything about mail.
 */

/** Why a grant was made (audit meta `reason` of `delegation.granted`). */
export type DelegationGrantReason = "admin" | "member_removed" | "converted_to_shared";

export type DelegationNote = {
  mailboxId: string;
  /** The mailbox's address (the entry's target label). */
  address: string;
  granteeUserId: string;
  /** The person's sign-in address when known (masked in the entry). */
  granteeEmail?: string | null;
  right: DelegationRight;
};

export function delegationEntry(
  action: "delegation.granted" | "delegation.revoked",
  note: DelegationNote,
  reason: DelegationGrantReason | DelegationRevokeReason,
  accountId?: string,
): AuditAlso {
  return {
    action,
    ...(accountId === undefined ? {} : { accountId }),
    target: { type: "mailbox", id: note.mailboxId, label: note.address },
    meta: {
      mailboxId: note.mailboxId,
      granteeUserId: note.granteeUserId,
      ...(note.granteeEmail ? { grantee: maskEmail(note.granteeEmail) } : {}),
      right: note.right,
      reason,
    },
  };
}

async function emails(repos: Repositories, accountId: string): Promise<Map<string, string>> {
  return new Map((await repos.access.members(accountId)).map((m) => [m.userId, m.email] as const));
}

/** One `delegation.revoked` entry per grant that went. */
function revokedEntries(
  grants: readonly Pick<DelegationGrant, "mailboxId" | "granteeUserId" | "right">[],
  address: (mailboxId: string) => string,
  who: Map<string, string>,
  reason: DelegationRevokeReason,
  accountId?: string,
): AuditAlso[] {
  return grants.map((g) =>
    delegationEntry(
      "delegation.revoked",
      {
        mailboxId: g.mailboxId,
        address: address(g.mailboxId),
        granteeUserId: g.granteeUserId,
        granteeEmail: who.get(g.granteeUserId) ?? null,
        right: g.right,
      },
      reason,
      accountId,
    ),
  );
}

/** A mailbox is being deleted or purged: every grant on it goes (`mailbox_deleted`). */
export async function dropMailboxGrants(
  repos: Repositories,
  accountId: string,
  mailbox: { id: string; address: string },
): Promise<AuditAlso[]> {
  const gone = await repos.delegation.revokeAllForMailbox(accountId, mailbox.id);
  if (gone.length === 0) return [];
  return revokedEntries(gone, () => mailbox.address, await emails(repos, accountId), "mailbox_deleted");
}

/**
 * A person is leaving the account (removed, or deleting their own login): every grant they hold in it goes
 * (`member_removed`). Call it before the membership is removed (its foreign key would take the rows unrecorded).
 * `accountScoped`: write the entries in that account's log even when the mutation is recorded elsewhere.
 */
export async function dropPersonGrants(
  repos: Repositories,
  accountId: string,
  userId: string,
  opts: { accountScoped?: boolean } = {},
): Promise<AuditAlso[]> {
  const gone = await repos.delegation.revokeAllForGrantee(accountId, userId);
  if (gone.length === 0) return [];
  const addresses = new Map((await repos.mailboxes.listByAccount(accountId)).map((m) => [m.id, m.address] as const));
  return revokedEntries(
    gone,
    (id) => addresses.get(id) ?? "",
    await emails(repos, accountId),
    "member_removed",
    opts.accountScoped === true ? accountId : undefined,
  );
}

/**
 * A mailbox now belongs to `userId` ("Make this a user"): the rights that person held on it as a delegate go
 * (`became_owner`); everyone else's stay.
 */
export async function dropOwnGrants(
  repos: Repositories,
  accountId: string,
  mailbox: { id: string; address: string },
  userId: string,
): Promise<AuditAlso[]> {
  const gone: Pick<DelegationGrant, "mailboxId" | "granteeUserId" | "right">[] = [];
  for (const right of await repos.delegation.rightsOf(accountId, mailbox.id, userId)) {
    if (await repos.delegation.revoke(accountId, mailbox.id, userId, right)) {
      gone.push({ mailboxId: mailbox.id, granteeUserId: userId, right });
    }
  }
  if (gone.length === 0) return [];
  return revokedEntries(gone, () => mailbox.address, await emails(repos, accountId), "became_owner");
}

/**
 * Guard rail 8 after a promotion (review 2026-10-30): a grant on an Owner's or an administrator's mailbox must have
 * been made by an Owner. When a person becomes an Owner, or gets an admin role from Member (`changeMemberRole`, or
 * "Make this a user" with an admin role), the grants on their mailboxes in the account that weren't made by a current
 * Owner go (`role_changed`) — e.g. a User Administrator's grant on a Member's or a shared mailbox. Call it after the
 * role is written, so a person promoted to Owner counts as one.
 */
export async function dropGrantsNotByOwners(
  repos: Repositories,
  accountId: string,
  userId: string,
): Promise<AuditAlso[]> {
  const members = await repos.people.list(accountId);
  const owners = new Set(members.filter((m) => m.role === "owner").map((m) => m.userId));
  const who = new Map(members.map((m) => [m.userId, m.email] as const));
  const theirs = (await repos.mailboxes.listByAccount(accountId)).filter((m) => m.userId === userId);
  const also: AuditAlso[] = [];
  for (const m of theirs) {
    const gone: DelegationGrant[] = [];
    for (const g of await repos.delegation.listForMailbox(accountId, m.id)) {
      if (g.grantedBy !== null && owners.has(g.grantedBy)) continue;
      if (await repos.delegation.revoke(accountId, m.id, g.granteeUserId, g.right)) gone.push(g);
    }
    also.push(...revokedEntries(gone, () => m.address, who, "role_changed"));
  }
  return also;
}
