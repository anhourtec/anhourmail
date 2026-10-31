// SPDX-License-Identifier: MIT
/**
 * One-off cleanup of the mail server's file storage (JMAP FileNode / WebDAV files), which customer accounts no longer
 * have (`FILE_STORAGE_PERMISSIONS` in `management.ts`, 2026-10-31). Files stored before the lockdown stay on the
 * account, count against its storage, and the user can no longer list or remove them; a share made before it stays
 * too, and Stalwart's WebDAV `sync-collection` REPORT (a generic DAV permission CardDAV and CalDAV sync need) still
 * lists the shared files' names, sizes and types to the recipient (verified on v0.16.27). Clearing the shares closes
 * that; destroying the files frees the space.
 *
 * Needs a credential that acts inside other accounts (`FileNode/*` by `accountId`): the bootstrap administrator. None
 * of the three service keys can (no file permissions, and only the operations and audit keys have `impersonate`).
 * Reports counts only — never file names, sizes or who shared with whom.
 */
import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"] as const;
/** The pinned server's `maxObjectsInGet` and `maxObjectsInSet`. */
const PAGE = 500;
/** Folders go after their contents: one pass removes the leaves, so a tree this deep needs this many passes. */
const MAX_PASSES = 64;

export type FileStorageCleanup = {
  /** Accounts looked at. */
  accounts: number;
  /** Accounts that had at least one file or folder. */
  accountsWithFiles: number;
  /** Files and folders whose sharing was removed. */
  sharesCleared: number;
  /** Shares the server refused to remove (`notUpdated`, or missing from `updated`): still in place — a failure. */
  sharesRefused: number;
  /** Files and folders destroyed (`destroy: true` only). */
  destroyed: number;
  /** Files and folders still there after `destroy` (the server refused them); looked at by hand. */
  remaining: number;
  /** Accounts the server wouldn't answer for (e.g. gone meanwhile), possibly partly done: re-run. A failure. */
  skipped: number;
};

type Node = { id: string; parentId?: string | null; shareWith?: Record<string, unknown> | null };

async function nodes(mgmt: StalwartManagement, accountId: string): Promise<Node[]> {
  const out: Node[] = [];
  for (let position = 0; ; position += PAGE) {
    const r = await mgmt.transport.rawCall(USING, [
      ["FileNode/query", { accountId, position, limit: PAGE }, "q"],
      [
        "FileNode/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
          properties: ["parentId", "shareWith"],
        },
        "g",
      ],
    ]);
    const page = (r.get("g")?.list ?? []) as Node[];
    out.push(...page);
    if (((r.get("q")?.ids ?? []) as unknown[]).length < PAGE) return out;
  }
}

const chunks = (ids: readonly string[]): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PAGE) out.push(ids.slice(i, i + PAGE));
  return out;
};

const shared = (n: Node): boolean =>
  n.shareWith !== null && n.shareWith !== undefined && Object.keys(n.shareWith).length > 0;

/**
 * For every account (`accountIds`, else every account the server has, of any type — users and groups alike, all
 * pages): removes the sharing of every file and
 * folder, and with `destroy` removes the files and folders themselves. Idempotent; email, contacts and calendars are
 * not touched. `skipAccountIds` leaves accounts out (e.g. the service accounts).
 */
export async function clearFileStorage(
  mgmt: StalwartManagement,
  opts: { destroy: boolean; accountIds?: readonly string[]; skipAccountIds?: readonly string[] },
): Promise<FileStorageCleanup> {
  const skip = new Set(opts.skipAccountIds ?? []);
  const ids = (
    opts.accountIds ?? (await mgmt.transport.getAll<{ id: string }>("x:Account", ["name"])).map((a) => a.id)
  ).filter((id) => !skip.has(id));
  const out: FileStorageCleanup = {
    accounts: 0,
    accountsWithFiles: 0,
    sharesCleared: 0,
    sharesRefused: 0,
    destroyed: 0,
    remaining: 0,
    skipped: 0,
  };
  for (const accountId of ids) {
    out.accounts += 1;
    try {
      let list = await nodes(mgmt, accountId);
      if (list.length === 0) continue;
      out.accountsWithFiles += 1;
      const sharedIds = list.filter(shared).map((n) => n.id);
      // At most `maxObjectsInSet` (500) per call. Only what the server says it updated counts; anything else is still
      // shared (and still listed by the REPORT).
      for (const batch of chunks(sharedIds)) {
        const r = await mgmt.transport.rawCall(USING, [
          [
            "FileNode/set",
            { accountId, update: Object.fromEntries(batch.map((id) => [id, { shareWith: null }])) },
            "s",
          ],
        ]);
        const updated = new Set(Object.keys(r.get("s")?.updated ?? {}));
        out.sharesCleared += batch.filter((id) => updated.has(id)).length;
        out.sharesRefused += batch.filter((id) => !updated.has(id)).length;
      }
      if (!opts.destroy) continue;
      for (let pass = 0; pass < MAX_PASSES && list.length > 0; pass++) {
        const parents = new Set(list.map((n) => n.parentId).filter((p): p is string => typeof p === "string"));
        const leaves = list.filter((n) => !parents.has(n.id)).map((n) => n.id);
        for (const batch of chunks(leaves)) {
          const r = await mgmt.transport.rawCall(USING, [["FileNode/set", { accountId, destroy: batch }, "d"]]);
          out.destroyed += ((r.get("d")?.destroyed ?? []) as unknown[]).length;
        }
        list = await nodes(mgmt, accountId);
      }
      out.remaining += list.length;
    } catch (err) {
      if (!(err instanceof StalwartError)) throw err;
      out.skipped += 1;
    }
  }
  return out;
}
