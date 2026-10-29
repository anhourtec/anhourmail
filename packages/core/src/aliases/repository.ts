// SPDX-License-Identifier: AGPL-3.0-only
import type { AliasKind, MailAlias } from "./entity";

/** Aliases. Reads are scoped to the owning account, so another account's ids are simply not found. */
export type AliasRepository = {
  listByAccount(accountId: string): Promise<MailAlias[]>;
  get(accountId: string, id: string): Promise<MailAlias | null>;
  count(accountId: string, kind: AliasKind): Promise<number>;
  /** Throws `ConflictError` if the address is already an alias (the database's unique index is the backstop). */
  insert(alias: MailAlias): Promise<void>;
  /** `adminLocked` is stored as given (the service keeps it false whenever `enabled` is true). */
  setEnabled(id: string, enabled: boolean, adminLocked: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Aliases of this kind the account created on this UTC day (`YYYY-MM-DD`), deleted ones included: a count of
   * creations, never of the aliases that exist.
   */
  creationsOn(accountId: string, kind: AliasKind, day: string): Promise<number>;
  /** Counts one more creation of this kind on this UTC day; the account's counts from before yesterday may be dropped (yesterday's is kept for clock skew). */
  recordCreation(accountId: string, kind: AliasKind, day: string): Promise<void>;
};
