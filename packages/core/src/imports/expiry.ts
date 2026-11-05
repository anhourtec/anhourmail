// SPDX-License-Identifier: AGPL-3.0-only
import { recordSystemChanges } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { endImport } from "./lifecycle";

const SYSTEM = { kind: "system", name: "import-expiry" } as const;
const BATCH = 100;
/** How long a person-stopped sync waits for its last pass before the sweep ends it anyway. */
export const LAST_PASS_GRACE_MS = 3_600_000;

export type ImportExpiryReport = {
  /** Terminal imports that still held a secret, a username or a folder name (never expected: `end` wipes them). */
  leftoversWiped: number;
  /** Paused or blocked imports whose destination credential expired: failed `expired`. */
  expired: number;
  /** Syncing imports whose sync window ended: completed. */
  syncEnded: number;
};

/**
 * `job:import-expiry` (hourly, ADR-0030 §2, §16): the belt-and-braces sweep. Terminal imports that still hold anything
 * sealed are wiped (and their credential's revoke queued); paused or blocked imports whose destination credential has
 * expired end as `failed` (`expired`); syncing imports past their window end as `completed` (the credential ends with
 * the window, so no last pass can run; a sync the person stopped gets `LAST_PASS_GRACE_MS` for its last pass first).
 * Each change is audited with it, counts and codes only.
 */
export async function expireImports(deps: Deps): Promise<ImportExpiryReport> {
  const now = deps.clock.now();
  const req: RequestMeta = { requestId: `import-expiry-${String(now.getTime())}`, ip: null, userAgent: null };
  const report: ImportExpiryReport = { leftoversWiped: 0, expired: 0, syncEnded: 0 };

  await deps.uow.run(async (r) => {
    const ids = await r.imports.wipeLeftovers(now, BATCH);
    for (const id of ids) {
      const i = await r.imports.getById(id);
      if (!i) continue;
      await r.provisioning.enqueue({ kind: "mail_import.credential_revoke", subjectId: id, runAfter: now });
      await recordSystemChanges(deps, r, SYSTEM, req, [
        {
          action: "data.import_credentials_wiped",
          accountId: i.accountId,
          target: { type: "mail_import", id },
          meta: { importId: id, mailboxId: i.mailboxId, sealedCleared: true, leftover: true },
        },
      ]);
      report.leftoversWiped += 1;
    }
  });

  for (const i of await deps.uow.run((r) => r.imports.pastCredential(now, BATCH))) {
    await deps.uow.run(async (r) => {
      const ended = await endImport(r, i.id, { status: "failed", at: now, errorCode: "expired" });
      if (!ended) return;
      await recordSystemChanges(deps, r, SYSTEM, req, [
        {
          action: "data.import_finished",
          accountId: i.accountId,
          target: { type: "mail_import", id: i.id },
          meta: {
            importId: i.id,
            mailboxId: i.mailboxId,
            status: "failed",
            errorCode: "expired",
            messagesDone: ended.messagesDone,
            duplicates: ended.duplicates,
            tooLarge: ended.tooLarge,
            failed: ended.failed,
          },
        },
      ]);
      report.expired += 1;
    });
  }

  for (const i of await deps.uow.run((r) => r.imports.pastSyncWindow(now, BATCH))) {
    // Stopped by the person (the window moved to then) while the credential still works: the importer's last pass is
    // due, so it gets an hour to run it before this ends the import without one.
    const credentialLeft = (i.destinationCredentialExpiresAt?.getTime() ?? 0) > now.getTime();
    if (credentialLeft && (i.syncUntil?.getTime() ?? 0) > now.getTime() - LAST_PASS_GRACE_MS) continue;
    await deps.uow.run(async (r) => {
      const ended = await endImport(r, i.id, { status: "completed", at: now });
      if (!ended) return;
      const target = { type: "mail_import", id: i.id };
      await recordSystemChanges(deps, r, SYSTEM, req, [
        {
          action: "data.import_sync_stopped",
          accountId: i.accountId,
          target,
          meta: { importId: i.id, mailboxId: i.mailboxId, reason: "window_ended" },
        },
        {
          action: "data.import_finished",
          accountId: i.accountId,
          target,
          meta: {
            importId: i.id,
            mailboxId: i.mailboxId,
            status: "completed",
            messagesDone: ended.messagesDone,
            duplicates: ended.duplicates,
            tooLarge: ended.tooLarge,
            failed: ended.failed,
          },
        },
      ]);
      report.syncEnded += 1;
    });
  }
  return report;
}
