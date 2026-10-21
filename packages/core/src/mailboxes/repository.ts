// SPDX-License-Identifier: AGPL-3.0-only
import type { Mailbox } from "./entity";

/** Mailboxes. Reads are scoped to the owning account, so another account's ids are simply not found. */
export type MailboxRepository = {
  listByAccount(accountId: string): Promise<Mailbox[]>;
  get(accountId: string, id: string): Promise<Mailbox | null>;
  count(accountId: string): Promise<number>;
  /** Used by any mailbox or alias, in any account (addresses are global). */
  addressTaken(address: string): Promise<boolean>;
  insert(mailbox: Mailbox): Promise<void>;
  setQuota(id: string, quotaBytes: number): Promise<void>;
};
