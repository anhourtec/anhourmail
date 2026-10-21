// SPDX-License-Identifier: AGPL-3.0-only
import type { Permission } from "@anhourmail/shared/rbac";

import { type Actor, authorize } from "./actor";
import type { AuditAction } from "./audit/catalogue";
import { auditActor, redactMeta, requestFields } from "./audit/record";
import type { AuditEntryInput, AuditResult, AuditScope } from "./audit/types";
import { DomainError, ForbiddenError } from "./errors";
import type { Deps, Repositories, RequestMeta } from "./ports";

export type MutationSpec = {
  action: AuditAction;
  permission: Permission;
  /** Account the mutation belongs to; null for platform/public mutations. */
  accountId: string | null;
  target: { type: string; id?: string | null; label?: string | null };
};

export type MutationOutcome<T> = {
  result: T;
  target?: { id?: string | null; label?: string | null };
  meta?: Record<string, unknown>;
  /** Business-level refusal that still commits nothing but is audited as denied (e.g. a bot check). */
  denied?: { code: string };
};

/**
 * The only way a service writes (CLAUDE.md rule 46; enforced by scripts/check-audit.mjs):
 *   1. authorize (403 / 404 / 401) — refusals are audited as `denied`, then rethrown;
 *   2. run `fn` in one unit of work and append the `success` audit entry in the same transaction — if the
 *      audit write fails, the change rolls back;
 *   3. if `fn` throws, record a `failed` entry in a separate unit of work and rethrow.
 */
export async function mutation<T>(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  fn: (repos: Repositories) => Promise<MutationOutcome<T>>,
): Promise<T> {
  const scope: AuditScope = spec.accountId === null ? "platform" : `account:${spec.accountId}`;
  const base = (result: AuditResult, errorCode: string | null, entryScope: AuditScope): AuditEntryInput => ({
    scope: entryScope,
    action: spec.action,
    ...auditActor(actor, spec.accountId),
    target: { type: spec.target.type, id: spec.target.id ?? null, label: spec.target.label ?? null },
    result,
    errorCode,
    ...requestFields(req),
    meta: {},
  });

  try {
    authorize(actor, spec.permission, spec.accountId ?? undefined);
  } catch (err) {
    if (err instanceof DomainError) {
      // Only an account's own members see its log: probes from outside go to the platform log.
      const entryScope = err instanceof ForbiddenError ? scope : "platform";
      await deps.uow.run((r) => r.audit.append(base("denied", err.code, entryScope), deps.clock.now()));
    }
    throw err;
  }

  try {
    return await deps.uow.run(async (repos) => {
      const out = await fn(repos);
      const entry = base(out.denied ? "denied" : "success", out.denied?.code ?? null, scope);
      entry.target = {
        type: spec.target.type,
        id: out.target?.id ?? spec.target.id ?? null,
        label: out.target?.label ?? spec.target.label ?? null,
      };
      entry.meta = redactMeta(out.meta ?? {});
      await repos.audit.append(entry, deps.clock.now());
      return out.result;
    });
  } catch (err) {
    const code = err instanceof DomainError ? err.code : "server_error";
    await deps.uow.run((r) => r.audit.append(base("failed", code, scope), deps.clock.now())).catch(() => undefined);
    throw err;
  }
}
