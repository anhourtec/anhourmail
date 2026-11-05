// SPDX-License-Identifier: AGPL-3.0-only
import { FileSpreadsheet, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { canBatchImport, listImports } from "@anhourmail/core/imports";
import { isTerminalImportStatus } from "@anhourmail/shared/import";
import { PageHeader } from "@anhourmail/ui/page-header";

import { CommandBar, CommandLink } from "@/components/console/command-bar";
import { ListEmpty } from "@/components/console/data-list";
import { listClass } from "@/components/console/list-classes";
import { AutoRefresh } from "@/components/imports/auto-refresh";
import { count, ImportProgress, importPercent, ImportStatus, toWire, when } from "@/components/imports/import-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Import mail" };

/**
 * Import mail (ADR-0030 §17): the caller's imports (every mailbox's for admins with `mailbox.import.any`), newest
 * first, with status and progress; "New import", and for admins "Import many mailboxes (CSV)". Refreshes itself while
 * an import is running.
 */
export default async function ImportsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const rows = await forPage(() => listImports(container().deps, actor, accountId));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Import mail" }];
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const docs = `${env().SITE_URL.replace(/\/$/, "")}/docs/import`;
  if (rows === null) {
    return (
      <>
        <PageHeader title="Import mail" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn&apos;t include importing mail.</p>
      </>
    );
  }
  const imports = rows.map((r) => toWire(r));
  const live = imports.some((i) => !isTerminalImportStatus(i.status));
  return (
    <>
      <PageHeader
        title="Import mail"
        description="Copy mail, folders, flags and dates from another provider into a mailbox here. The old mailbox is only read: nothing there changes."
        breadcrumbs={crumbs}
      />
      <CommandBar label="Import actions">
        <CommandLink href={`${base}/new`} icon={<Plus />}>
          New import
        </CommandLink>
        {canBatchImport(actor, accountId) && (
          <CommandLink href={`${base}/batch/new`} icon={<FileSpreadsheet />}>
            Import many mailboxes (CSV)
          </CommandLink>
        )}
      </CommandBar>
      {live && <AutoRefresh everyMs={5000} />}
      {imports.length === 0 ? (
        <ListEmpty>
          No imports yet. Start one to copy your mail from another provider; you&apos;ll need an app password from
          there.
        </ListEmpty>
      ) : (
        <div className={listClass.wrap}>
          <table className={listClass.table} aria-label="Mail imports">
            <thead>
              <tr>
                <th className={listClass.th}>Into</th>
                <th className={listClass.th}>From</th>
                <th className={listClass.th}>Status</th>
                <th className={`${listClass.th} min-w-40`}>Progress</th>
                <th className={`${listClass.th} hidden md:table-cell`}>Started</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => {
                const pct = importPercent(i);
                return (
                  <tr key={i.id} className={listClass.row}>
                    <td className={listClass.td}>
                      <Link
                        href={`${base}/${i.id}`}
                        className="font-mono text-[14px] text-primary underline-offset-2 hover:underline"
                      >
                        {i.address}
                      </Link>
                      {!i.startedByYou && i.requestedAs === "admin" && (
                        <span className="am-micro ml-2 whitespace-nowrap">started by an admin</span>
                      )}
                    </td>
                    <td className={`${listClass.td} font-mono text-[13px]`}>{i.sourceHost}</td>
                    <td className={listClass.td}>
                      <ImportStatus value={i} />
                    </td>
                    <td className={listClass.td}>
                      <div className="flex min-w-40 flex-col gap-1">
                        <ImportProgress value={pct} label={`Progress for ${i.address}`} />
                        <span className="am-micro font-mono">
                          {count(i.messagesDone)} copied
                          {i.messagesTotal > 0 ? ` of ${count(i.messagesTotal)}` : ""}
                        </span>
                      </div>
                    </td>
                    <td className={`${listClass.td} am-small hidden whitespace-nowrap md:table-cell`}>
                      {when(i.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="am-small">
        What moves, what doesn&apos;t, and how to make an app password at your old provider:{" "}
        <a href={docs} className="text-primary underline-offset-2 hover:underline">
          importing mail guide
        </a>
        .
      </p>
    </>
  );
}
