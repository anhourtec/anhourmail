// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { DATA_EXPORT, type DataExportKind, type DataExportStatus } from "@anhourmail/shared/data-lifecycle";
import type { Permission } from "@anhourmail/shared/rbac";

import { type Actor, authorize } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, StepUpRequiredError } from "../errors";
import { mutation, type MutationOutcome, type MutationSpec } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { accountExportFiles, personalExportFiles } from "./archive";
import type { DataExport } from "./entity";
import type { ExportArchiver } from "./repository";

/**
 * Data exports (ADR-0025). An Owner asks for an account export (`account.export`) and anyone for their own data
 * (`self.data.export`); the scheduler's `data-export` job builds the archive (control-plane data only), seals it with the
 * key ring and emails the person. Only the person who asked can download it, after a fresh step-up, until it expires
 * (`DATA_EXPORT.keepDays`); then the archive is deleted. Never while staff act as someone. Every step is audited:
 * `data.export_requested`, `data.export_ready` (system), `data.export_downloaded`, `data.export_expired` (system).
 */

/** What the console shows of an export: never the archive or its error. */
export type DataExportView = {
  id: string;
  kind: DataExportKind;
  status: DataExportStatus;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  downloadedAt: Date | null;
  sizeBytes: number | null;
};

/** How many past exports the page lists. */
const LIST_LIMIT = 10;

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export const exportView = (e: DataExport): DataExportView => ({
  id: e.id,
  kind: e.kind,
  status: e.status,
  createdAt: e.createdAt,
  readyAt: e.readyAt,
  expiresAt: e.expiresAt,
  downloadedAt: e.downloadedAt,
  sizeBytes: e.sizeBytes,
});

/** Which export a request is about: one account's, or the person's own. */
export type ExportScope = { kind: "account"; accountId: string } | { kind: "personal" };

const permissionOf = (s: ExportScope): Permission => (s.kind === "account" ? "account.export" : "self.data.export");
const accountOf = (s: ExportScope): string | null => (s.kind === "account" ? s.accountId : null);

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required";

function throwRefusal(r: Refusal): never {
  if (r === "act_as")
    throw new ForbiddenError("Data exports can't be requested or downloaded while acting as someone.");
  throw new StepUpRequiredError();
}

/** Asks for an export. One at a time per person and kind: 409 while one is waiting or being built. */
export async function requestExport(
  deps: Deps,
  actor: Actor,
  scope: ExportScope,
  req: RequestMeta,
): Promise<DataExportView> {
  const accountId = accountOf(scope);
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "data.export_requested",
      permission: permissionOf(scope),
      accountId,
      target: scope.kind === "account" ? { type: "account", id: accountId } : { type: "user" },
    },
    async (repos): Promise<MutationOutcome<DataExportView | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      const target =
        scope.kind === "account"
          ? { id: scope.accountId, label: (await repos.accounts.get(scope.accountId))?.name ?? null }
          : { id: actor.userId, label: maskEmail(actor.email) };
      if (actor.actingAs) return { result: "act_as", target, denied: { code: "act_as" } };
      if (scope.kind === "account") await repos.accounts.lock(scope.accountId);
      const recent = await repos.dataLifecycle.listExports(actor.userId, scope.kind, accountId, LIST_LIMIT);
      if (recent.some((e) => e.status === "queued" || e.status === "building")) {
        throw new ConflictError("An export is already being prepared. We'll email you when it's ready.");
      }
      const row: DataExport = {
        id: randomUUID(),
        kind: scope.kind,
        accountId,
        requestedBy: actor.userId,
        status: "queued",
        createdAt: deps.clock.now(),
        startedAt: null,
        readyAt: null,
        expiresAt: null,
        downloadedAt: null,
        sizeBytes: null,
        attempts: 0,
        error: null,
      };
      await repos.dataLifecycle.insertExport(row);
      return { result: exportView(row), target, meta: { exportId: row.id, kind: scope.kind } };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** The person's own recent exports of this kind (an account's: only the ones they asked for). */
export async function listExports(deps: Deps, actor: Actor, scope: ExportScope): Promise<DataExportView[]> {
  authorize(actor, permissionOf(scope), accountOf(scope) ?? undefined);
  if (actor.kind !== "user") throw new ForbiddenError();
  if (actor.actingAs) throwRefusal("act_as");
  const rows = await deps.uow.run((r) =>
    r.dataLifecycle.listExports(actor.userId, scope.kind, accountOf(scope), LIST_LIMIT),
  );
  return rows.map(exportView);
}

export type DownloadedExport = { filename: string; bytes: Uint8Array };

/**
 * The archive of a ready export, opened for its download: only for the person who asked (anyone else, another account,
 * another kind or an unknown id: 404), after a fresh step-up on this console session, until it expires (409 after).
 */
export async function downloadExport(
  deps: Deps,
  archiver: ExportArchiver,
  actor: Actor,
  scope: ExportScope,
  exportId: string,
  session: Session,
  req: RequestMeta,
): Promise<DownloadedExport> {
  const accountId = accountOf(scope);
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "data.export_downloaded",
      permission: permissionOf(scope),
      accountId,
      target: { type: "data_export", id: isId(exportId) ? exportId : null },
    },
    async (repos): Promise<MutationOutcome<DownloadedExport | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      const e = isId(exportId) ? await repos.dataLifecycle.getExport(exportId) : null;
      if (e?.requestedBy !== actor.userId || e.kind !== scope.kind || e.accountId !== accountId) {
        throw new NotFoundError();
      }
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return { result: "step_up_required", denied: { code: "step_up_required" } };
      }
      const now = deps.clock.now();
      if (e.status === "expired" || (e.expiresAt !== null && e.expiresAt <= now)) {
        throw new ConflictError("This export has expired and was deleted. Ask for a new one.");
      }
      const sealed = e.status === "ready" ? await repos.dataLifecycle.archive(e.id) : null;
      if (!sealed) throw new ConflictError("This export isn't ready yet. We'll email you when it is.");
      const bytes = await archiver.open(e.id, sealed);
      await repos.dataLifecycle.markDownloaded(e.id, now);
      const day = (e.readyAt ?? now).toISOString().slice(0, 10);
      return {
        result: {
          filename: `anhourmail-${scope.kind === "account" ? "account" : "personal"}-export-${day}.zip`,
          bytes,
        },
        meta: { kind: e.kind, sizeBytes: bytes.byteLength },
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

const BUILDER = { kind: "system", name: "data-export" } as const;

/** A finished build: who to email (their sign-in address) and until when it can be downloaded. */
export type BuiltExport = {
  exportId: string;
  kind: DataExportKind;
  accountId: string | null;
  email: string;
  expiresAt: Date;
};

/** The archive was built but couldn't be stored (the claim was taken over, or the export is gone). */
class ExportBuildError extends DomainError {
  constructor(code: string) {
    super("The export couldn't be built.", code);
  }
}

const buildSpec = (e: DataExport): MutationSpec => ({
  action: "data.export_ready",
  permission: e.kind === "account" ? "account.export" : "self.data.export",
  accountId: e.kind === "account" ? e.accountId : null,
  target: { type: "data_export", id: e.id },
});

async function filesFor(deps: Deps, r: Repositories, e: DataExport, at: Date) {
  if (e.kind === "account") {
    if (!e.accountId) throw new Error("account export without an account");
    return accountExportFiles(deps, r, e.accountId, at);
  }
  return personalExportFiles(r, e.requestedBy, at);
}

/**
 * Scheduler (`job:data-export`): builds the oldest waiting export, if any. Resumable: a build that crashed is taken over
 * after `DATA_EXPORT.staleBuildMinutes`; a failure is retried up to `DATA_EXPORT.maxAttempts`, then marked failed (and
 * audited as `failed`). Returns what was built, `"failed"` / `"retry"` for a failure, or null when nothing waited.
 */
export async function buildNextExport(
  deps: Deps,
  archiver: ExportArchiver,
): Promise<BuiltExport | "failed" | "retry" | null> {
  const now = deps.clock.now();
  const staleBefore = new Date(now.getTime() - DATA_EXPORT.staleBuildMinutes * 60_000);
  const claimed = await deps.uow.run((r) => r.dataLifecycle.claimExport(now, staleBefore));
  if (!claimed?.startedAt) return null;
  const startedAt = claimed.startedAt;
  const meta = { requestId: `export-${claimed.id}`, ip: null, userAgent: null };
  try {
    const files = await deps.uow.run((r) => filesFor(deps, r, claimed, now));
    const sealed = await archiver.pack(claimed.id, files, now);
    const expiresAt = new Date(now.getTime() + DATA_EXPORT.keepDays * 86_400_000);
    return await mutation(deps, BUILDER, meta, buildSpec(claimed), async (repos) => {
      if (!(await repos.dataLifecycle.storeArchive(claimed.id, startedAt, sealed, now, expiresAt))) {
        throw new ExportBuildError("lock_lost");
      }
      const person = await repos.dataLifecycle.person(claimed.requestedBy);
      if (!person) throw new ExportBuildError("not_found");
      return {
        result: {
          exportId: claimed.id,
          kind: claimed.kind,
          accountId: claimed.accountId,
          email: person.email,
          expiresAt,
        },
        target: { label: claimed.kind === "account" ? null : maskEmail(person.email) },
        meta: { kind: claimed.kind, files: files.length, sizeBytes: sealed.byteLength, attempt: claimed.attempts },
      };
    });
  } catch (err) {
    if (err instanceof ExportBuildError && err.code === "lock_lost") return "retry"; // another run holds it now
    const giveUp = claimed.attempts >= DATA_EXPORT.maxAttempts;
    const name = err instanceof Error ? err.name : "unknown";
    await deps.uow.run((r) => r.dataLifecycle.failExport(claimed.id, startedAt, name, giveUp));
    if (!giveUp) return "retry";
    // Recorded as `failed` by mutation() (the person sees it in the list and can ask again).
    await mutation(deps, BUILDER, meta, buildSpec(claimed), () => {
      throw new ExportBuildError("export_failed");
    }).catch(() => undefined);
    return "failed";
  }
}

/** Scheduler: deletes the archives of exports past their download window, audited as `data.export_expired`. */
export async function expireExports(deps: Deps, limit = 100): Promise<number> {
  const now = deps.clock.now();
  // Nothing due: no audit entry (the job runs every minute).
  if (!(await deps.uow.run((r) => r.dataLifecycle.anyExpired(now)))) return 0;
  const expired = await mutation(
    deps,
    BUILDER,
    { requestId: `export-expiry-${now.toISOString()}`, ip: null, userAgent: null },
    { action: "data.export_expired", permission: "self.data.export", accountId: null, target: { type: "data_export" } },
    async (repos) => {
      const rows = await repos.dataLifecycle.expireExports(now, limit);
      return {
        result: rows,
        meta: { count: rows.length },
        // Each account export's own log shows its archive went (rule 49: the account sees what happens to its data).
        copies: rows
          .filter((e) => e.kind === "account" && e.accountId !== null)
          .map((e) => ({ accountId: e.accountId, target: { id: e.id }, meta: { kind: e.kind } })),
      };
    },
  );
  return expired.length;
}
