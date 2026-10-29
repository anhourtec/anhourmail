// SPDX-License-Identifier: MIT
/**
 * The Archive folder (ADR-0014). Stalwart creates a new account's special folders the first time its mail store is
 * opened, from `x:Email.defaultFolders` merged over built-in defaults; on the pinned v0.16.27 the built-in Archive
 * has `create: false`, so no account got one (verified 2026-10-29: Inbox, Drafts, Sent Items, Junk Mail and Deleted
 * Items only). `applyDefaultFolders` turns it on server-wide, so every account opened afterwards gets "Archive" with
 * role `archive` from Stalwart itself; it needs a settings reload, and only accounts whose store hasn't been opened
 * yet are affected (verified: setting it, with or without a reload, never adds a folder to an existing account).
 *
 * Accounts opened before that are backfilled with `ensureArchiveFolder` / `backfillArchiveFolders`, which act inside
 * the account (`Mailbox/get` and `Mailbox/set` with its `accountId`) and so need owner access: the deployment's
 * bootstrap administrator, or the dev admin. None of the control plane's three keys can (`keys.ts`: the provisioning
 * key has no `impersonate`, the operations and audit keys have no mailbox permissions), and customers can't create
 * folders over JMAP themselves (`CUSTOMER_PERMISSIONS` denies `jmapMailboxCreate`/`Update`).
 *
 * Both only ever create a folder or set the role on one; they never move, rename, delete or read mail.
 */
import type { StalwartManagement } from "./management";

export const ARCHIVE_FOLDER_NAME = "Archive";

/** `x:Email.defaultFolders` entry for Archive (schema `x:EmailFolder`: name, create, subscribe, aliases). */
export const ARCHIVE_DEFAULT_FOLDER = {
  name: ARCHIVE_FOLDER_NAME,
  create: true,
  subscribe: true,
  aliases: {},
} as const;

const MAIL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"] as const;

/**
 * Makes Stalwart create Archive (role `archive`) for every account opened from now on. Patches only the `archive`
 * entry, so other default folders keep whatever they have. Idempotent. Callers run `reloadSettings()` afterwards
 * (without it the change doesn't apply, verified).
 */
export async function applyDefaultFolders(mgmt: StalwartManagement): Promise<void> {
  await mgmt.updateSingleton("x:Email", { "defaultFolders/archive": ARCHIVE_DEFAULT_FOLDER });
}

export type FolderSummary = { id: string; name: string; role: string | null; parentId: string | null };

export type ArchivePlan = { action: "none"; id: string } | { action: "setRole"; id: string } | { action: "create" };

/**
 * What an account needs for Archive: nothing when any folder already has role `archive`; the role on a top-level
 * folder already named Archive (any case — Stalwart refuses a second top-level folder whose name differs only in
 * case, verified); otherwise a new top-level Archive.
 */
export function planArchiveFolder(folders: readonly FolderSummary[]): ArchivePlan {
  const withRole = folders.find((f) => f.role === "archive");
  if (withRole) return { action: "none", id: withRole.id };
  const named = folders.find((f) => f.parentId === null && f.name.toLowerCase() === ARCHIVE_FOLDER_NAME.toLowerCase());
  if (named) return { action: "setRole", id: named.id };
  return { action: "create" };
}

export type ArchiveResult = { action: "none" | "setRole" | "create"; id: string };

/**
 * Gives one account (its Stalwart id) an Archive folder if it has none (`planArchiveFolder`). Idempotent; needs owner
 * access to the account (see the module comment).
 */
export async function ensureArchiveFolder(mgmt: StalwartManagement, accountId: string): Promise<ArchiveResult> {
  const got = await mgmt.transport.rawCall(MAIL_USING, [
    ["Mailbox/get", { accountId, ids: null, properties: ["name", "role", "parentId"] }, "g"],
  ]);
  const folders = (got.get("g")?.list ?? []) as {
    id: string;
    name: string;
    role?: string | null;
    parentId?: string | null;
  }[];
  const plan = planArchiveFolder(
    folders.map((f) => ({ id: f.id, name: f.name, role: f.role ?? null, parentId: f.parentId ?? null })),
  );
  if (plan.action === "none") return plan;
  const args =
    plan.action === "setRole"
      ? { accountId, update: { [plan.id]: { role: "archive" } } }
      : {
          accountId,
          create: { a: { name: ARCHIVE_FOLDER_NAME, role: "archive", parentId: null, isSubscribed: true } },
        };
  const res = (await mgmt.transport.rawCall(MAIL_USING, [["Mailbox/set", args, "s"]])).get("s") ?? {};
  if (plan.action === "setRole") {
    const failed = res.notUpdated as Record<string, unknown> | null | undefined;
    if (failed && Object.keys(failed).length > 0) throw new Error("Archive role was not set");
    return plan;
  }
  const id = (res.created as Record<string, { id?: string }> | null | undefined)?.a?.id;
  if (!id) throw new Error("Archive folder was not created");
  return { action: "create", id };
}

export type ArchiveBackfillReport = {
  /** User accounts looked at (groups, accounts on `skipDomains` and, with `domains`, any other domain are left alone). */
  checked: number;
  created: number;
  roleSet: number;
  /** Stalwart ids of accounts that failed (no addresses); re-running retries them. */
  failed: string[];
};

/**
 * Runs `ensureArchiveFolder` for every user account on the server (or only those on `domains`, by name), except
 * those on `skipDomains` (the deployment's service-account domains). One account failing doesn't stop the rest. Safe
 * to re-run: a second run creates nothing.
 */
export async function backfillArchiveFolders(
  mgmt: StalwartManagement,
  opts: { skipDomains?: readonly string[]; domains?: readonly string[] } = {},
): Promise<ArchiveBackfillReport> {
  const names = (list: readonly string[] | undefined) => new Set((list ?? []).map((d) => d.toLowerCase()));
  const skip = names(opts.skipDomains);
  const only = opts.domains === undefined ? null : names(opts.domains);
  const domains = await mgmt.transport.getAll<{ id: string; name: string }>("x:Domain", ["name"]);
  const wanted = new Set(
    domains
      .filter((d) => !skip.has(d.name.toLowerCase()) && (only === null || only.has(d.name.toLowerCase())))
      .map((d) => d.id),
  );
  const accounts = await mgmt.transport.getAll<{ id: string; "@type"?: string; domainId?: string }>("x:Account", [
    "@type",
    "domainId",
  ]);
  const report: ArchiveBackfillReport = { checked: 0, created: 0, roleSet: 0, failed: [] };
  for (const a of accounts) {
    if (a["@type"] !== "User" || a.domainId === undefined || !wanted.has(a.domainId)) continue;
    report.checked++;
    try {
      const r = await ensureArchiveFolder(mgmt, a.id);
      if (r.action === "create") report.created++;
      if (r.action === "setRole") report.roleSet++;
    } catch {
      report.failed.push(a.id);
    }
  }
  return report;
}
