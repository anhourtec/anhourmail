// SPDX-License-Identifier: AGPL-3.0-only
import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { getImportBatch } from "@anhourmail/core/imports";
import { isTerminalImportStatus } from "@anhourmail/shared/import";
import { PageHeader } from "@anhourmail/ui/page-header";

import { listClass } from "@/components/console/list-classes";
import { AutoRefresh } from "@/components/imports/auto-refresh";
import { count, ImportProgress, importPercent, ImportStatus, toWire, when } from "@/components/imports/import-status";
import { secondaryButtonClass } from "@/components/ui-classes";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Import batch" };

/**
 * One admins' batch (ADR-0030 §8): each row's mailbox, status and counts (open one to pause, resume or cancel it), and
 * the report CSV. Refreshes itself while any of them runs. Another account's batch is the 404 page.
 */
export default async function BatchPage({ params }: { params: Promise<{ accountId: string; batchId: string }> }) {
  const { accountId, batchId } = await params;
  const actor = await requireUser();
  const batch = await forPage(() => getImportBatch(container().deps, actor, accountId, batchId));
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Import mail", href: base }, { label: "Batch" }];
  if (batch === null) {
    return (
      <>
        <PageHeader title="Import batch" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn&apos;t include batch imports.</p>
      </>
    );
  }
  const imports = batch.imports.map((i) => toWire(i));
  const live = imports.some((i) => !isTerminalImportStatus(i.status));
  const report = `/api/accounts/${encodeURIComponent(accountId)}/import-batches/${encodeURIComponent(batch.id)}/report`;
  return (
    <>
      <PageHeader
        title="Import batch"
        description={`Uploaded ${when(batch.createdAt.toISOString())}${batch.createdByYou ? " by you" : ""}: ${String(imports.length)} ${imports.length === 1 ? "import" : "imports"} from ${String(batch.rows)} ${batch.rows === 1 ? "row" : "rows"}.`}
        breadcrumbs={crumbs}
        actions={
          <a href={report} className={secondaryButtonClass}>
            <Download className="size-4" aria-hidden />
            Download report
          </a>
        }
      />
      {live && <AutoRefresh everyMs={5000} />}
      <div className={listClass.wrap}>
        <table className={listClass.table} aria-label="Imports in this batch">
          <thead>
            <tr>
              <th className={listClass.th}>Mailbox</th>
              <th className={listClass.th}>Status</th>
              <th className={`${listClass.th} min-w-40`}>Progress</th>
              <th className={`${listClass.th} hidden text-right sm:table-cell`}>Skipped</th>
            </tr>
          </thead>
          <tbody>
            {imports.map((i) => (
              <tr key={i.id} className={listClass.row}>
                <td className={listClass.td}>
                  <Link
                    href={`${base}/${i.id}`}
                    className="font-mono text-[14px] text-primary underline-offset-2 hover:underline"
                  >
                    {i.address}
                  </Link>
                </td>
                <td className={listClass.td}>
                  <ImportStatus value={i} />
                </td>
                <td className={listClass.td}>
                  <div className="flex min-w-40 flex-col gap-1">
                    <ImportProgress value={importPercent(i)} label={`Progress for ${i.address}`} />
                    <span className="am-micro font-mono">{count(i.messagesDone)} copied</span>
                  </div>
                </td>
                <td className={`${listClass.td} hidden text-right font-mono sm:table-cell`}>{count(i.duplicates)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="am-small">
        A row that needs you (a refused sign-in, a full mailbox) is fixed and resumed from its own page.
      </p>
    </>
  );
}
