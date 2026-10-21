// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEntry, AuditEntryInput, AuditScope } from "./types";

export type AuditQuery = {
  scope: AuditScope;
  action?: string;
  actorUserId?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  /** Return entries with seq lower than this (newest-first paging). */
  beforeSeq?: number;
};

/**
 * Append-only (CLAUDE.md rule 47): there is no update or delete. `append` must serialise per scope
 * (e.g. an advisory lock) so the chain has no forks, and run inside the caller's unit of work.
 */
export type AuditRepository = {
  append(input: AuditEntryInput, at: Date): Promise<AuditEntry>;
  /** Newest first. */
  list(query: AuditQuery): Promise<AuditEntry[]>;
  /** Whole chain for a scope, oldest first (verification job). */
  chain(scope: AuditScope): Promise<AuditEntry[]>;
};
