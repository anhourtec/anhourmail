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
