// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { ACCOUNT_SAFE_SENDERS, accountSafeChars, senderEntry } from "@anhourmail/shared/senders";

import { type Actor, authorize, can } from "../actor";
import { NotFoundError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

/**
 * The account-wide Safe senders list (ADR-0032 §1): addresses and domains the account's Owners and User
 * Administrators trust for every mailbox. Images from them load when the From is verified, and their mail skips the
 * "trusted only" Junk check; a person's own Blocked senders still win. Entries are admin configuration kept in the
 * control plane; they are never logged or audited (counts and kinds only, rule 48). The web app applies changes to
 * each mailbox's managed script after the change is committed (it alone may write Sieve, ADR-0020).
 */

export type AccountSafeSenderView = { id: string; entry: string; kind: "address" | "domain"; createdAt: Date };

export type AccountSafeSenderList = {
  entries: AccountSafeSenderView[];
  /** Whether the actor may add and remove entries here (the UI hides what they can't do). */
  canManage: boolean;
  limits: { maxEntries: number; maxChars: number; usedChars: number };
};

const kindOf = (entry: string): "address" | "domain" => (entry.includes("@") ? "address" : "domain");
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** At most this many entries in one add request (a pasted list). */
export const MAX_SAFE_SENDERS_PER_ADD = 100;

const list = (rows: { id: string; entry: string; createdAt: Date }[]): AccountSafeSenderView[] =>
  rows.map((r) => ({ id: r.id, entry: r.entry, kind: kindOf(r.entry), createdAt: r.createdAt }));

/** The account's list (`safe_sender.read`). Another account's id is a 404. */
export async function listAccountSafeSenders(
  deps: Deps,
  actor: Actor,
  input: { accountId: string },
): Promise<AccountSafeSenderList> {
  authorize(actor, "safe_sender.read", input.accountId);
  const rows = await deps.uow.run((r) => r.webmailSettings.accountSafeSenders(input.accountId));
  return {
    entries: list(rows),
    canManage: can(actor, "safe_sender.manage", input.accountId),
    limits: {
      maxEntries: ACCOUNT_SAFE_SENDERS.maxEntries,
      maxChars: ACCOUNT_SAFE_SENDERS.maxChars,
      usedChars: accountSafeChars(rows.map((r) => r.entry)),
    },
  };
}

/** Typed entries checked and normalised; the message names the first one that isn't an address or a domain. */
function entries(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new ValidationError("Add an address or a domain.");
  if (input.length > MAX_SAFE_SENDERS_PER_ADD) {
    throw new ValidationError(`Add up to ${String(MAX_SAFE_SENDERS_PER_ADD)} entries at a time.`);
  }
  const out = new Set<string>();
  for (const raw of input) {
    const e = typeof raw === "string" ? senderEntry(raw) : null;
    if (e === null) {
      const shown = typeof raw === "string" ? raw.trim().slice(0, 60) : "";
      throw new ValidationError(
        shown === ""
          ? "One entry is empty."
          : `"${shown}" isn't an address or a domain (jane@example.com, example.com).`,
      );
    }
    out.add(e);
  }
  return [...out];
}

/**
 * Adds entries (`safe_sender.manage`). Entries already there are skipped; the list's caps are checked under the
 * account's lock. Audited `junk_rules.account_safe_added` with counts only.
 */
export async function addAccountSafeSenders(
  deps: Deps,
  actor: Actor,
  input: { accountId: string; entries: unknown },
  req: RequestMeta,
): Promise<AccountSafeSenderList & { added: number }> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "junk_rules.account_safe_added",
      permission: "safe_sender.manage",
      accountId: input.accountId,
      target: { type: "account", id: input.accountId },
    },
    async (r) => {
      const wanted = entries(input.entries);
      await r.webmailSettings.lockAccountSafeSenders(input.accountId);
      const before = await r.webmailSettings.accountSafeSenders(input.accountId);
      const have = new Set(before.map((b) => b.entry));
      const fresh = wanted.filter((e) => !have.has(e));
      const all = [...before.map((b) => b.entry), ...fresh];
      if (all.length > ACCOUNT_SAFE_SENDERS.maxEntries) {
        throw new ValidationError(
          `The account's Safe senders list holds up to ${String(ACCOUNT_SAFE_SENDERS.maxEntries)} entries. Remove some first.`,
        );
      }
      if (accountSafeChars(all) > ACCOUNT_SAFE_SENDERS.maxChars) {
        throw new ValidationError("The account's Safe senders list is too long. Remove some entries first.");
      }
      const now = deps.clock.now();
      const by = actor.kind === "user" ? actor.userId : null;
      await r.webmailSettings.insertAccountSafeSenders(
        fresh.map((entry) => ({ id: randomUUID(), accountId: input.accountId, entry, createdBy: by, createdAt: now })),
      );
      const after = await r.webmailSettings.accountSafeSenders(input.accountId);
      const names = await r.access.accountNames([input.accountId]);
      return {
        result: {
          entries: list(after),
          canManage: true,
          limits: {
            maxEntries: ACCOUNT_SAFE_SENDERS.maxEntries,
            maxChars: ACCOUNT_SAFE_SENDERS.maxChars,
            usedChars: accountSafeChars(after.map((a) => a.entry)),
          },
          added: fresh.length,
        },
        target: { label: names[input.accountId] ?? null },
        meta: {
          added: fresh.length,
          addresses: fresh.filter((e) => kindOf(e) === "address").length,
          domains: fresh.filter((e) => kindOf(e) === "domain").length,
          total: after.length,
        },
      };
    },
  );
}

/** Removes one entry (`safe_sender.manage`); an id not in this account is a 404. Audited with its kind only. */
export async function removeAccountSafeSender(
  deps: Deps,
  actor: Actor,
  input: { accountId: string; id: string },
  req: RequestMeta,
): Promise<AccountSafeSenderList> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "junk_rules.account_safe_removed",
      permission: "safe_sender.manage",
      accountId: input.accountId,
      target: { type: "account", id: input.accountId },
    },
    async (r) => {
      if (!isUuid(input.id)) throw new NotFoundError();
      await r.webmailSettings.lockAccountSafeSenders(input.accountId);
      const before = await r.webmailSettings.accountSafeSenders(input.accountId);
      const row = before.find((b) => b.id === input.id);
      if (!row || !(await r.webmailSettings.deleteAccountSafeSender(input.accountId, input.id))) {
        throw new NotFoundError();
      }
      const after = before.filter((b) => b.id !== input.id);
      const names = await r.access.accountNames([input.accountId]);
      return {
        result: {
          entries: list(after),
          canManage: true,
          limits: {
            maxEntries: ACCOUNT_SAFE_SENDERS.maxEntries,
            maxChars: ACCOUNT_SAFE_SENDERS.maxChars,
            usedChars: accountSafeChars(after.map((a) => a.entry)),
          },
        },
        target: { label: names[input.accountId] ?? null },
        meta: { kind: kindOf(row.entry), total: after.length },
      };
    },
  );
}

/**
 * The account list that applies to a mailbox, by its address (the webmail: the session's own mailbox, or the shared
 * mailbox a delegated tab admitted). No actor: the caller already holds that mailbox's session. Empty for an address
 * the control plane doesn't hold.
 */
export async function accountSafeSendersForMailbox(
  deps: Deps,
  address: string,
): Promise<{ accountId: string; entries: string[] } | null> {
  const key = address.trim().toLowerCase();
  return deps.uow.run(async (r) => {
    const m = await r.webmailSettings.mailboxByAddress(key);
    if (!m) return null;
    const rows = await r.webmailSettings.accountSafeSenders(m.accountId);
    return { accountId: m.accountId, entries: rows.map((x) => x.entry) };
  });
}

/** An account's entries, for the web app's rewrite of its mailboxes' scripts (system path, no actor). */
export async function accountSafeSenderEntries(deps: Deps, accountId: string): Promise<string[]> {
  const rows = await deps.uow.run((r) => r.webmailSettings.accountSafeSenders(accountId));
  return rows.map((x) => x.entry);
}
