// SPDX-License-Identifier: AGPL-3.0-only
import type { AliasKind, MailAlias } from "./entity";

/** Aliases. Reads are scoped to the owning account, so another account's ids are simply not found. */
export type AliasRepository = {
  listByAccount(accountId: string): Promise<MailAlias[]>;
  get(accountId: string, id: string): Promise<MailAlias | null>;
  count(accountId: string, kind: AliasKind): Promise<number>;
  /** Throws `ConflictError` if the address is already an alias (the database's unique index is the backstop). */
  insert(alias: MailAlias): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
};
