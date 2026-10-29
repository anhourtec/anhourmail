// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";

import { ConflictError } from "@anhourmail/core";
import type { AccountDeletion, DataExport, DataLifecycleRepository, PersonRecord } from "@anhourmail/core/data";
import { DATA_EXPORT_STATUSES, type DataExportKind, type DataExportStatus } from "@anhourmail/shared/data-lifecycle";

import type { Executor } from "./client";
import { isUniqueViolation } from "./errors";
import { accountDeletion, accountMembership, authUser, customerAccount, dataExport } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column but the archive (lists never read it). */
const exportFields = {
  id: dataExport.id,
  kind: dataExport.kind,
  accountId: dataExport.accountId,
  requestedBy: dataExport.requestedBy,
  status: dataExport.status,
  attempts: dataExport.attempts,
  error: dataExport.error,
  sizeBytes: dataExport.sizeBytes,
  createdAt: dataExport.createdAt,
  startedAt: dataExport.startedAt,
  readyAt: dataExport.readyAt,
  expiresAt: dataExport.expiresAt,
  downloadedAt: dataExport.downloadedAt,
};

type ExportRow = Omit<DataExport, "kind" | "status"> & { kind: string; status: string };

/** A stored row as the domain type; null for a kind or status this code doesn't know (never trusted). */
function toExport(r: ExportRow): DataExport | null {
  if (r.kind !== "account" && r.kind !== "personal") return null;
  if (!(DATA_EXPORT_STATUSES as readonly string[]).includes(r.status)) return null;
  return { ...r, kind: r.kind, status: r.status as DataExportStatus };
}

const exports = (rows: ExportRow[]): DataExport[] => rows.flatMap((r) => toExport(r) ?? []);

const deletionFields = {
  accountId: accountDeletion.accountId,
  requestedBy: accountDeletion.requestedBy,
  requestedAt: accountDeletion.requestedAt,
  deleteAfter: accountDeletion.deleteAfter,
  startedAt: accountDeletion.startedAt,
};

/** Data exports and account deletion (ADR-0025): the `data_export` and `account_deletion` tables. */
export class PgDataLifecycleRepository implements DataLifecycleRepository {
  constructor(private readonly x: Executor) {}

  async insertExport(e: DataExport): Promise<void> {
    await this.x.insert(dataExport).values({
      id: e.id,
      kind: e.kind,
      accountId: e.accountId,
      requestedBy: e.requestedBy,
      status: e.status,
      attempts: e.attempts,
      error: e.error,
      sizeBytes: e.sizeBytes,
      createdAt: e.createdAt,
      startedAt: e.startedAt,
      readyAt: e.readyAt,
      expiresAt: e.expiresAt,
      downloadedAt: e.downloadedAt,
    });
  }

  async getExport(id: string): Promise<DataExport | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.x.select(exportFields).from(dataExport).where(eq(dataExport.id, id));
    return row ? toExport(row) : null;
  }

  async listExports(
    requestedBy: string,
    kind: DataExportKind,
    accountId: string | null,
    limit: number,
  ): Promise<DataExport[]> {
    if (accountId !== null && !UUID.test(accountId)) return [];
    const rows = await this.x
      .select(exportFields)
      .from(dataExport)
      .where(
        and(
          eq(dataExport.requestedBy, requestedBy),
          eq(dataExport.kind, kind),
          accountId === null ? isNull(dataExport.accountId) : eq(dataExport.accountId, accountId),
        ),
      )
      .orderBy(desc(dataExport.createdAt), desc(dataExport.id))
      .limit(limit);
    return exports(rows);
  }

  async claimExport(now: Date, staleBefore: Date): Promise<DataExport | null> {
    const res = await this.x.execute<{ id: string }>(sql`
      update data_export
      set status = 'building', started_at = ${now}, attempts = attempts + 1, error = null
      where id = (
        select e.id from data_export e
        where e.status = 'queued' or (e.status = 'building' and e.started_at < ${staleBefore})
        order by e.created_at
        limit 1
        for update skip locked
      )
      returning id`);
    const id = res.rows[0]?.id;
    return id ? this.getExport(id) : null;
  }

  async storeArchive(id: string, startedAt: Date, sealed: Uint8Array, readyAt: Date, expiresAt: Date) {
    const rows = await this.x
      .update(dataExport)
      .set({ status: "ready", archive: sealed, sizeBytes: sealed.byteLength, readyAt, expiresAt, error: null })
      .where(and(eq(dataExport.id, id), eq(dataExport.status, "building"), eq(dataExport.startedAt, startedAt)))
      .returning({ id: dataExport.id });
    return rows.length > 0;
  }

  async failExport(id: string, startedAt: Date, error: string, giveUp: boolean) {
    const rows = await this.x
      .update(dataExport)
      .set({ status: giveUp ? "failed" : "queued", error: error.slice(0, 100) })
      .where(and(eq(dataExport.id, id), eq(dataExport.status, "building"), eq(dataExport.startedAt, startedAt)))
      .returning({ id: dataExport.id });
    return rows.length > 0;
  }

  async markDownloaded(id: string, at: Date): Promise<void> {
    await this.x.update(dataExport).set({ downloadedAt: at }).where(eq(dataExport.id, id));
  }

  async archive(id: string): Promise<Uint8Array | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.x
      .select({ archive: dataExport.archive })
      .from(dataExport)
      .where(and(eq(dataExport.id, id), eq(dataExport.status, "ready")));
    return row?.archive ?? null;
  }

  async anyExpired(now: Date): Promise<boolean> {
    const [row] = await this.x
      .select({ id: dataExport.id })
      .from(dataExport)
      .where(and(eq(dataExport.status, "ready"), lte(dataExport.expiresAt, now)))
      .limit(1);
    return row !== undefined;
  }

  async expireExports(now: Date, limit: number): Promise<DataExport[]> {
    const res = await this.x.execute<{ id: string }>(sql`
      update data_export set status = 'expired', archive = null
      where id in (
        select id from data_export where status = 'ready' and expires_at <= ${now}
        order by expires_at limit ${limit} for update skip locked
      )
      returning id`);
    const out: DataExport[] = [];
    for (const r of res.rows) {
      const e = await this.getExport(r.id);
      if (e) out.push(e);
    }
    return out;
  }

  async getDeletion(accountId: string): Promise<AccountDeletion | null> {
    if (!UUID.test(accountId)) return null;
    const [row] = await this.x
      .select(deletionFields)
      .from(accountDeletion)
      .where(eq(accountDeletion.accountId, accountId));
    return row ?? null;
  }

  async scheduleDeletion(d: AccountDeletion): Promise<void> {
    try {
      await this.x.insert(accountDeletion).values(d);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("This account is already scheduled for deletion.");
      throw err;
    }
  }

  async cancelDeletion(accountId: string): Promise<boolean> {
    const rows = await this.x
      .delete(accountDeletion)
      .where(and(eq(accountDeletion.accountId, accountId), isNull(accountDeletion.startedAt)))
      .returning({ id: accountDeletion.accountId });
    return rows.length > 0;
  }

  async startDeletion(accountId: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(accountDeletion)
      .set({ startedAt: at })
      .where(
        and(
          eq(accountDeletion.accountId, accountId),
          isNull(accountDeletion.startedAt),
          lte(accountDeletion.deleteAfter, at),
        ),
      )
      .returning({ id: accountDeletion.accountId });
    return rows.length > 0;
  }

  async dueDeletions(now: Date, limit: number): Promise<AccountDeletion[]> {
    return this.x
      .select(deletionFields)
      .from(accountDeletion)
      .where(lte(accountDeletion.deleteAfter, now))
      .orderBy(asc(accountDeletion.deleteAfter))
      .limit(limit);
  }

  async pendingDeletions(): Promise<(AccountDeletion & { accountName: string })[]> {
    return this.x
      .select({ ...deletionFields, accountName: customerAccount.name })
      .from(accountDeletion)
      .innerJoin(customerAccount, eq(customerAccount.id, accountDeletion.accountId))
      .orderBy(asc(accountDeletion.deleteAfter))
      .limit(500);
  }

  async deletingAccountsOf(userId: string): Promise<string[]> {
    const rows = await this.x
      .select({ id: accountDeletion.accountId })
      .from(accountDeletion)
      .innerJoin(accountMembership, eq(accountMembership.accountId, accountDeletion.accountId))
      .where(eq(accountMembership.userId, userId));
    return rows.map((r) => r.id);
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    if (!UUID.test(accountId)) return false;
    const rows = await this.x
      .delete(customerAccount)
      .where(eq(customerAccount.id, accountId))
      .returning({ id: customerAccount.id });
    return rows.length > 0;
  }

  async person(userId: string): Promise<PersonRecord | null> {
    const [row] = await this.x
      .select({
        id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
        emailVerified: authUser.emailVerified,
        createdAt: authUser.createdAt,
      })
      .from(authUser)
      .where(eq(authUser.id, userId));
    return row ?? null;
  }

  async accountCreatedAt(accountId: string): Promise<Date | null> {
    if (!UUID.test(accountId)) return null;
    const [row] = await this.x
      .select({ createdAt: customerAccount.createdAt })
      .from(customerAccount)
      .where(eq(customerAccount.id, accountId));
    return row?.createdAt ?? null;
  }

  async lockLogin(userId: string): Promise<void> {
    // FOR UPDATE conflicts with the FOR KEY SHARE a new membership's foreign key takes on this row.
    await this.x.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, userId)).for("update");
  }

  async deleteLogin(userId: string): Promise<boolean> {
    // Sessions, sign-in factors, the profile, the photo, memberships and exports cascade from the login (schema.ts).
    const rows = await this.x.delete(authUser).where(eq(authUser.id, userId)).returning({ id: authUser.id });
    return rows.length > 0;
  }
}
