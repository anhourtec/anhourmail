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
  /** Taken through a staff (platform) path: staff are recorded as staff even if they belong to the account. */
  staffPath?: true;
};

export type MutationOutcome<T> = {
  result: T;
  target?: { id?: string | null; label?: string | null };
  meta?: Record<string, unknown>;
  /** Business-level refusal that still commits nothing but is audited as denied (e.g. a bot check). */
  denied?: { code: string };
  /**
   * The same action recorded again in other scopes, in the same unit of work, each with its own meta: e.g. a staff
   * suspension in the platform log (with the internal note) and in each affected account's log (without it, rule 49).
   */
  copies?: {
    accountId: string | null;
    target?: { id?: string | null; label?: string | null };
    meta: Record<string, unknown>;
  }[];
};

/**
 * The only way a service writes (CLAUDE.md rule 46; enforced by scripts/check-audit.mjs):
 *   1. authorize (403 / 404 / 401) — refusals are audited as `denied`, then rethrown;
 *   2. run `fn` in one unit of work and append the `success` audit entry in the same transaction — if the
 *      audit write fails, the change rolls back;
 *   3. if `fn` throws, record a `failed` entry in a separate unit of work and rethrow.
 */
const auditBase = (
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  result: AuditResult,
  errorCode: string | null,
  scope: AuditScope,
): AuditEntryInput => ({
  scope,
  action: spec.action,
  ...auditActor(actor, spec.accountId, spec.staffPath === true),
  target: { type: spec.target.type, id: spec.target.id ?? null, label: spec.target.label ?? null },
  result,
  errorCode,
  ...requestFields(req),
  meta: {},
});

const scopeOf = (spec: MutationSpec): AuditScope =>
  spec.accountId === null ? "platform" : `account:${spec.accountId}`;

/**
 * Step 1 of `mutation()` on its own: authorize, and audit a refusal as `denied` before rethrowing. For services that
 * must do slow work (e.g. DNS lookups) before opening the unit of work; they still call `mutation()` afterwards.
 */
export async function authorizeAudited(deps: Deps, actor: Actor, req: RequestMeta, spec: MutationSpec) {
  try {
    authorize(actor, spec.permission, spec.accountId ?? undefined);
  } catch (err) {
    if (err instanceof DomainError) {
      // Only an account's own members see its log: probes from outside go to the platform log.
      const entryScope = err instanceof ForbiddenError ? scopeOf(spec) : "platform";
      await deps.uow.run((r) =>
        r.audit.append(auditBase(actor, req, spec, "denied", err.code, entryScope), deps.clock.now()),
      );
    }
    throw err;
  }
}

export async function mutation<T>(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  fn: (repos: Repositories) => Promise<MutationOutcome<T>>,
): Promise<T> {
  const scope = scopeOf(spec);
  const base = (result: AuditResult, errorCode: string | null, entryScope: AuditScope) =>
    auditBase(actor, req, spec, result, errorCode, entryScope);

  await authorizeAudited(deps, actor, req, spec);

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
      for (const copy of out.copies ?? []) {
        const copySpec = { ...spec, accountId: copy.accountId };
        await repos.audit.append(
          {
            ...auditBase(actor, req, copySpec, entry.result, entry.errorCode, scopeOf(copySpec)),
            target: {
              type: spec.target.type,
              id: copy.target?.id ?? entry.target.id,
              label: copy.target?.label ?? entry.target.label,
            },
            meta: redactMeta(copy.meta),
          },
          deps.clock.now(),
        );
      }
      return out.result;
    });
  } catch (err) {
    const code = err instanceof DomainError ? err.code : "server_error";
    await deps.uow.run((r) => r.audit.append(base("failed", code, scope), deps.clock.now())).catch(() => undefined);
    throw err;
  }
}
