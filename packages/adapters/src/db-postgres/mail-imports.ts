// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import {
  finishedSourceHost,
  importOptions,
  type MailImport,
  type MailImportBatch,
  type MailImportFolder,
  type MailImportFolderStatus,
  type MailImportPatch,
  type MailImportRepository,
  type NewMailImport,
  type TerminalImportStatus,
} from "@anhourmail/core/imports";
import {
  IMPORT_BLOCKED_REASONS,
  IMPORT_FOLDER_ROLES,
  IMPORT_PHASES,
  IMPORT_STATUSES,
  IMPORT_TERMINAL_STATUSES,
  type ImportBlockedReason,
  type ImportFolderRole,
  type ImportPhase,
  type ImportStatus,
  isImportSourcePort,
} from "@anhourmail/shared/import";

import type { Executor } from "./client";
import { mailImport, mailImportBatch, mailImportFolder } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: string) => UUID.test(v);

type Row = typeof mailImport.$inferSelect;
type FolderRow = typeof mailImportFolder.$inferSelect;

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | null =>
  v !== null && (list as readonly string[]).includes(v) ? (v as T) : null;

const TERMINAL = IMPORT_TERMINAL_STATUSES as readonly string[];
const live = sql`${mailImport.status} not in ('completed', 'cancelled', 'failed')`;

/** A row as the domain type. Rows with a status or port this release doesn't know are left out, never guessed at. */
function toImport(r: Row): MailImport | null {
  const status = oneOf<ImportStatus>(IMPORT_STATUSES, r.status);
  if (status === null || !isImportSourcePort(r.sourcePort) || r.sourceKind !== "imap_password") return null;
  return {
    id: r.id,
    accountId: r.accountId,
    mailboxId: r.mailboxId,
    batchId: r.batchId,
    requestedBy: r.requestedBy,
    requestedAs: r.requestedAs === "admin" ? "admin" : "own",
    sourceKind: "imap_password",
    sourceHost: r.sourceHost,
    sourcePort: r.sourcePort,
    sourceUsername: r.sourceUsername,
    sourceSecret: r.sourceSecret,
    destinationSecret: r.destinationSecret,
    destinationCredentialId: r.destinationCredentialId,
    destinationCredentialCreatedAt: r.destinationCredentialCreatedAt,
    destinationCredentialExpiresAt: r.destinationCredentialExpiresAt,
    options: importOptions(r.options),
    status,
    phase: oneOf<ImportPhase>(IMPORT_PHASES, r.phase),
    blockedReason: oneOf<ImportBlockedReason>(IMPORT_BLOCKED_REASONS, r.blockedReason),
    errorCode: r.errorCode,
    pauseRequested: r.pauseRequested,
    foldersTotal: r.foldersTotal,
    messagesTotal: r.messagesTotal,
    bytesTotal: r.bytesTotal,
    messagesDone: r.messagesDone,
    bytesDone: r.bytesDone,
    duplicates: r.duplicates,
    tooLarge: r.tooLarge,
    failed: r.failed,
    leaseToken: r.leaseToken,
    leaseUntil: r.leaseUntil,
    runAfter: r.runAfter,
    attempts: r.attempts,
    syncUntil: r.syncUntil,
    lastPassAt: r.lastPassAt,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    credentialsWipedAt: r.credentialsWipedAt,
    notifiedAt: r.notifiedAt,
  };
}

const toImports = (rows: Row[]): MailImport[] => rows.flatMap((r) => toImport(r) ?? []);

const FOLDER_STATUSES: readonly MailImportFolderStatus[] = ["pending", "copying", "done", "skipped"];

const toFolder = (r: FolderRow): MailImportFolder => ({
  id: r.id,
  importId: r.importId,
  role: oneOf<ImportFolderRole>(IMPORT_FOLDER_ROLES, r.role),
  sourcePath: r.sourcePath,
  uidValidity: r.uidValidity,
  lastUid: r.lastUid,
  messagesTotal: r.messagesTotal,
  messagesDone: r.messagesDone,
  duplicates: r.duplicates,
  tooLarge: r.tooLarge,
  failed: r.failed,
  bytesDone: r.bytesDone,
  status: oneOf(FOLDER_STATUSES, r.status) ?? "pending",
  updatedAt: r.updatedAt,
});

/** A patch as column values; a terminal status never gets through (`end` is the only way there). */
function columns(patch: MailImportPatch): Partial<typeof mailImport.$inferInsert> {
  const { status, ...rest } = patch;
  if (status !== undefined && TERMINAL.includes(status)) throw new Error("use end() to finish an import");
  return { ...rest, ...(status === undefined ? {} : { status }) };
}

/** Mail imports (ADR-0030 §12). Reads for people are scoped to the account. */
export class PgMailImportRepository implements MailImportRepository {
  constructor(private readonly x: Executor) {}

  async insert(row: NewMailImport): Promise<"ok" | "import_running"> {
    // ON CONFLICT DO NOTHING: a unique violation would abort the caller's transaction (its audit row with it).
    const inserted = await this.x
      .insert(mailImport)
      .values({ ...row, status: "queued" })
      .onConflictDoNothing()
      .returning({ id: mailImport.id });
    return inserted.length === 1 ? "ok" : "import_running";
  }

  async get(accountId: string, id: string): Promise<MailImport | null> {
    if (!isId(accountId) || !isId(id)) return null;
    const [r] = await this.x
      .select()
      .from(mailImport)
      .where(and(eq(mailImport.accountId, accountId), eq(mailImport.id, id)));
    return r ? toImport(r) : null;
  }

  async getById(id: string): Promise<MailImport | null> {
    if (!isId(id)) return null;
    const [r] = await this.x.select().from(mailImport).where(eq(mailImport.id, id));
    return r ? toImport(r) : null;
  }

  async list(
    accountId: string,
    filter: { mailboxIds: readonly string[] | null; limit: number },
  ): Promise<MailImport[]> {
    if (!isId(accountId)) return [];
    const ids = filter.mailboxIds?.filter(isId) ?? null;
    if (ids !== null && ids.length === 0) return [];
    const rows = await this.x
      .select()
      .from(mailImport)
      .where(and(eq(mailImport.accountId, accountId), ids === null ? undefined : inArray(mailImport.mailboxId, ids)))
      .orderBy(desc(mailImport.createdAt), desc(mailImport.id))
      .limit(filter.limit);
    return toImports(rows);
  }

  async activeForMailbox(mailboxId: string): Promise<MailImport | null> {
    if (!isId(mailboxId)) return null;
    const [r] = await this.x
      .select()
      .from(mailImport)
      .where(and(eq(mailImport.mailboxId, mailboxId), live));
    return r ? toImport(r) : null;
  }

  async update(id: string, patch: MailImportPatch): Promise<MailImport | null> {
    if (!isId(id)) return null;
    const set = columns(patch);
    if (Object.keys(set).length === 0) {
      const [r] = await this.x
        .select()
        .from(mailImport)
        .where(and(eq(mailImport.id, id), live));
      return r ? toImport(r) : null;
    }
    const [r] = await this.x
      .update(mailImport)
      .set(set)
      .where(and(eq(mailImport.id, id), live))
      .returning();
    return r ? toImport(r) : null;
  }

  async end(
    id: string,
    end: { status: TerminalImportStatus; at: Date; errorCode?: string | null },
  ): Promise<MailImport | null> {
    if (!isId(id) || !TERMINAL.includes(end.status)) return null;
    // Both statements in one transaction (a savepoint inside a unit of work): no folder path outlives the end.
    return this.x.transaction(async (tx) => {
      const [current] = await tx
        .select({ sourceHost: mailImport.sourceHost })
        .from(mailImport)
        .where(and(eq(mailImport.id, id), live))
        .for("update");
      if (!current) return null;
      const [r] = await tx
        .update(mailImport)
        .set({
          status: end.status,
          ...(end.errorCode === undefined ? {} : { errorCode: end.errorCode }),
          sourceSecret: null,
          destinationSecret: null,
          sourceUsername: null,
          sourceHost: finishedSourceHost(current.sourceHost),
          credentialsWipedAt: end.at,
          finishedAt: end.at,
          leaseToken: null,
          leaseUntil: null,
          pauseRequested: false,
        })
        .where(and(eq(mailImport.id, id), live))
        .returning();
      if (!r) return null;
      await tx.update(mailImportFolder).set({ sourcePath: null }).where(eq(mailImportFolder.importId, id));
      return toImport(r);
    });
  }

  async wipeLeftovers(at: Date, limit: number): Promise<string[]> {
    const terminal = inArray(mailImport.status, [...TERMINAL]);
    const withFolderPath = sql`exists (select 1 from ${mailImportFolder} where ${mailImportFolder.importId} = ${mailImport.id} and ${mailImportFolder.sourcePath} is not null)`;
    const rows = await this.x
      .select({ id: mailImport.id, sourceHost: mailImport.sourceHost })
      .from(mailImport)
      .where(
        and(
          terminal,
          or(
            isNotNull(mailImport.sourceSecret),
            isNotNull(mailImport.destinationSecret),
            isNotNull(mailImport.sourceUsername),
            withFolderPath,
          ),
        ),
      )
      .orderBy(asc(mailImport.createdAt))
      .limit(limit);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    for (const r of rows) {
      await this.x
        .update(mailImport)
        .set({
          sourceSecret: null,
          destinationSecret: null,
          sourceUsername: null,
          sourceHost: finishedSourceHost(r.sourceHost),
          credentialsWipedAt: sql`coalesce(${mailImport.credentialsWipedAt}, ${at})`,
        })
        .where(eq(mailImport.id, r.id));
    }
    await this.x.update(mailImportFolder).set({ sourcePath: null }).where(inArray(mailImportFolder.importId, ids));
    return ids;
  }

  async claim(
    at: Date,
    opts: { token: string; leaseMs: number; perAccount: number; global: number },
  ): Promise<(MailImport & { abandonedLeaseUntil: Date | null }) | null> {
    // Its own transaction (a savepoint inside a unit of work), so the lock below is always transaction-scoped and is
    // released with the claim, even when the caller runs on the pool rather than in a unit of work.
    return this.x.transaction(async (tx) => {
      // One lock for every claim: the counts below and the update can't race another runner.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mail_import:claim', 0))`);
      const leased = and(isNotNull(mailImport.leaseUntil), sql`${mailImport.leaseUntil} > ${at}`);
      const [held] = await this.x
        .select({ n: sql<number>`count(*)::int` })
        .from(mailImport)
        .where(and(live, leased));
      if ((held?.n ?? 0) >= opts.global) return null;
      const busyAccount = sql`(select count(*) from ${mailImport} as other where other.account_id = ${mailImport.accountId} and other.status not in ('completed', 'cancelled', 'failed') and other.lease_until is not null and other.lease_until > ${at}) >= ${opts.perAccount}`;
      const [due] = await this.x
        .select({ id: mailImport.id, leaseUntil: mailImport.leaseUntil })
        .from(mailImport)
        .where(
          and(
            inArray(mailImport.status, ["queued", "running", "syncing"]),
            lte(mailImport.runAfter, at),
            or(isNull(mailImport.leaseUntil), lte(mailImport.leaseUntil, at)),
            sql`not ${busyAccount}`,
          ),
        )
        .orderBy(asc(mailImport.runAfter), asc(mailImport.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!due) return null;
      const [r] = await this.x
        .update(mailImport)
        .set({
          leaseToken: opts.token,
          leaseUntil: new Date(at.getTime() + opts.leaseMs),
          status: sql`case when ${mailImport.status} = 'queued' then 'running' else ${mailImport.status} end`,
          startedAt: sql`coalesce(${mailImport.startedAt}, ${at})`,
        })
        // Still claimable at the moment of the write (belt and braces next to the lock and SKIP LOCKED).
        .where(
          and(
            eq(mailImport.id, due.id),
            inArray(mailImport.status, ["queued", "running", "syncing"]),
            or(isNull(mailImport.leaseUntil), lte(mailImport.leaseUntil, at)),
          ),
        )
        .returning();
      const claimed = r ? toImport(r) : null;
      // A lease that was never given back: the runner that held it died mid-slice.
      return claimed ? { ...claimed, abandonedLeaseUntil: due.leaseUntil } : null;
    });
  }

  async renewLease(id: string, token: string, until: Date): Promise<boolean> {
    if (!isId(id)) return false;
    const r = await this.x
      .update(mailImport)
      .set({ leaseUntil: until })
      .where(and(eq(mailImport.id, id), eq(mailImport.leaseToken, token), live))
      .returning({ id: mailImport.id });
    return r.length === 1;
  }

  async progress(id: string, token: string, patch: MailImportPatch): Promise<boolean> {
    if (!isId(id)) return false;
    const set = columns(patch);
    const r = await this.x
      .update(mailImport)
      .set(Object.keys(set).length === 0 ? { leaseToken: token } : set)
      .where(and(eq(mailImport.id, id), eq(mailImport.leaseToken, token), live))
      .returning({ id: mailImport.id });
    return r.length === 1;
  }

  async release(id: string, token: string, patch: MailImportPatch): Promise<boolean> {
    if (!isId(id)) return false;
    const r = await this.x
      .update(mailImport)
      .set({ ...columns(patch), leaseToken: null, leaseUntil: null })
      .where(and(eq(mailImport.id, id), eq(mailImport.leaseToken, token), live))
      .returning({ id: mailImport.id });
    return r.length === 1;
  }

  async folders(importId: string): Promise<MailImportFolder[]> {
    if (!isId(importId)) return [];
    const rows = await this.x
      .select()
      .from(mailImportFolder)
      .where(eq(mailImportFolder.importId, importId))
      .orderBy(asc(mailImportFolder.createdAt), asc(mailImportFolder.id));
    return rows.map(toFolder);
  }

  async saveFolder(folder: MailImportFolder, token: string | null): Promise<boolean> {
    if (!isId(folder.importId) || !isId(folder.id)) return false;
    // Lock the import row: a concurrent `end` either sees this folder (and nulls its path) or this sees it ended.
    const [owner] = await this.x
      .select({ id: mailImport.id })
      .from(mailImport)
      .where(
        and(eq(mailImport.id, folder.importId), live, token === null ? undefined : eq(mailImport.leaseToken, token)),
      )
      .for("update");
    if (!owner) return false;
    const values = {
      role: folder.role,
      sourcePath: folder.sourcePath,
      uidValidity: folder.uidValidity,
      lastUid: folder.lastUid,
      messagesTotal: folder.messagesTotal,
      messagesDone: folder.messagesDone,
      duplicates: folder.duplicates,
      tooLarge: folder.tooLarge,
      failed: folder.failed,
      bytesDone: folder.bytesDone,
      status: folder.status,
      updatedAt: folder.updatedAt,
    };
    const r = await this.x
      .insert(mailImportFolder)
      .values({ id: folder.id, importId: folder.importId, ...values })
      .onConflictDoUpdate({
        target: mailImportFolder.id,
        set: values,
        // A folder id belongs to one import for good.
        setWhere: eq(mailImportFolder.importId, folder.importId),
      })
      .returning({ id: mailImportFolder.id });
    return r.length === 1;
  }

  async insertBatch(batch: MailImportBatch): Promise<void> {
    await this.x.insert(mailImportBatch).values(batch);
  }

  async getBatch(accountId: string, id: string): Promise<MailImportBatch | null> {
    if (!isId(accountId) || !isId(id)) return null;
    const [r] = await this.x
      .select()
      .from(mailImportBatch)
      .where(and(eq(mailImportBatch.accountId, accountId), eq(mailImportBatch.id, id)));
    return r ?? null;
  }

  async listBatch(accountId: string, batchId: string): Promise<MailImport[]> {
    if (!isId(accountId) || !isId(batchId)) return [];
    const rows = await this.x
      .select()
      .from(mailImport)
      .where(and(eq(mailImport.accountId, accountId), eq(mailImport.batchId, batchId)))
      .orderBy(asc(mailImport.createdAt), asc(mailImport.id));
    return toImports(rows);
  }

  async pastCredential(at: Date, limit: number): Promise<MailImport[]> {
    const rows = await this.x
      .select()
      .from(mailImport)
      .where(
        and(
          inArray(mailImport.status, ["paused", "blocked"]),
          isNotNull(mailImport.destinationCredentialExpiresAt),
          lte(mailImport.destinationCredentialExpiresAt, at),
        ),
      )
      .orderBy(asc(mailImport.destinationCredentialExpiresAt), asc(mailImport.id))
      .limit(limit);
    return toImports(rows);
  }

  async pastSyncWindow(at: Date, limit: number): Promise<MailImport[]> {
    const rows = await this.x
      .select()
      .from(mailImport)
      .where(and(eq(mailImport.status, "syncing"), isNotNull(mailImport.syncUntil), lte(mailImport.syncUntil, at)))
      .orderBy(asc(mailImport.syncUntil), asc(mailImport.id))
      .limit(limit);
    return toImports(rows);
  }

  async messagesCopiedInto(mailboxId: string, since: Date, exceptId: string): Promise<number> {
    if (!isId(mailboxId)) return 0;
    const [row] = await this.x
      .select({ n: sql<number>`coalesce(sum(${mailImport.messagesDone}), 0)::int` })
      .from(mailImport)
      .where(
        and(
          eq(mailImport.mailboxId, mailboxId),
          sql`${mailImport.id} <> ${isId(exceptId) ? exceptId : "00000000-0000-0000-0000-000000000000"}`,
          sql`${mailImport.createdAt} >= ${since}`,
        ),
      );
    return row?.n ?? 0;
  }

  async unnotified(limit: number): Promise<MailImport[]> {
    const rows = await this.x
      .select()
      .from(mailImport)
      .where(and(inArray(mailImport.status, [...TERMINAL]), isNull(mailImport.notifiedAt)))
      .orderBy(asc(mailImport.finishedAt), asc(mailImport.id))
      .limit(limit);
    return toImports(rows);
  }

  async markNotified(id: string, at: Date): Promise<boolean> {
    if (!isId(id)) return false;
    const r = await this.x
      .update(mailImport)
      .set({ notifiedAt: at })
      .where(and(eq(mailImport.id, id), isNull(mailImport.notifiedAt), inArray(mailImport.status, [...TERMINAL])))
      .returning({ id: mailImport.id });
    return r.length === 1;
  }
}
