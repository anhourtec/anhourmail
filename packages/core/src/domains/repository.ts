// SPDX-License-Identifier: AGPL-3.0-only
import type { CustomerDomain, DomainStatus } from "./entity";

/** Customer domains. Every read is scoped to the owning account, so another account's ids are simply not found. */
export type DomainRepository = {
  listByAccount(accountId: string): Promise<CustomerDomain[]>;
  get(accountId: string, id: string): Promise<CustomerDomain | null>;
  /** Claimed by any account: active or being removed (pending adds claim nothing). */
  nameTaken(name: string): Promise<boolean>;
  insert(domain: CustomerDomain): Promise<void>;
  /** Conditional transition; false if the domain was no longer in `from` (a concurrent change won). */
  transition(id: string, from: DomainStatus, to: DomainStatus): Promise<boolean>;
  /** Deletes a domain only while it is still pending; false if it changed meanwhile (e.g. a check activated it). */
  deletePending(id: string): Promise<boolean>;
  /** Mailboxes and aliases whose address is on this domain. */
  addressCount(name: string): Promise<number>;
  /** Pending domains created after `since`, in no fixed order (the scheduler samples them so none starves). */
  pending(since: Date, limit: number): Promise<CustomerDomain[]>;
};

/**
 * A customer domain's catch-all: the mailbox (of the same account) that receives mail for unknown addresses at the
 * domain. Callers scope the domain and the mailbox to the account first.
 */
export type CatchAllRepository = {
  /** The catch-all mailbox id, or null when it is off. */
  get(domainId: string): Promise<string | null>;
  set(domainId: string, mailboxId: string | null): Promise<void>;
  /** Turns off every catch-all that points at this mailbox; returns those domains. */
  clearForMailbox(mailboxId: string): Promise<{ id: string; name: string }[]>;
  /** Where the mail server sends unknown recipients: the catch-all mailbox's address while it is active, else null. */
  targetAddress(domainId: string): Promise<string | null>;
};
