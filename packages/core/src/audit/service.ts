// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, authorize } from "../actor";
import type { Deps } from "../ports";
import { verifyChain } from "./hash";
import type { AuditEntry, AuditScope } from "./types";

/** Page size from untrusted input: integers 1–200, default 50 (NaN, Infinity and fractions are rejected). */
export function clampLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return 50;
  return Math.min(Math.max(Math.trunc(input), 1), 200);
}

/** Account audit log for Owner / User Admin / Auditor (permission `audit.read`, account scope). */
export async function listAccountAudit(
  deps: Deps,
  actor: Actor,
  accountId: string,
  opts: { limit?: number; beforeSeq?: number } = {},
): Promise<AuditEntry[]> {
  authorize(actor, "audit.read", accountId);
  const limit = clampLimit(opts.limit);
  return deps.uow.run((r) =>
    r.audit.list({ scope: `account:${accountId}`, limit, ...(opts.beforeSeq ? { beforeSeq: opts.beforeSeq } : {}) }),
  );
}

/** Platform audit for Global Admin and Reports Reader. */
export async function listPlatformAudit(
  deps: Deps,
  actor: Actor,
  opts: { limit?: number } = {},
): Promise<AuditEntry[]> {
  authorize(actor, "platform.audit.read");
  const limit = clampLimit(opts.limit);
  return deps.uow.run((r) => r.audit.list({ scope: "platform", limit }));
}

/** Scheduled integrity check (system actor only). Returns the first break, or null when the chain is intact. */
export async function verifyAuditScope(deps: Deps, scope: AuditScope) {
  const entries = await deps.uow.run((r) => r.audit.chain(scope));
  return verifyChain(entries);
}
