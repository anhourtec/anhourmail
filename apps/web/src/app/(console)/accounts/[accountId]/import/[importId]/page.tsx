// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { getImport } from "@anhourmail/core/imports";
import { PageHeader } from "@anhourmail/ui/page-header";

import { ImportDetail } from "@/components/imports/import-detail";
import { toWire } from "@/components/imports/import-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { importContext } from "@/server/imports";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Mail import" };

/**
 * One mail import (ADR-0030 §17): live progress, the folders, the fix when it waits for the person, and the controls.
 * Another account's import, or one the person can't see, is the 404 page.
 */
export default async function ImportPage({ params }: { params: Promise<{ accountId: string; importId: string }> }) {
  const { accountId, importId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => getImport(container().deps, importContext().sealer, actor, accountId, importId));
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Import mail", href: base }, { label: "Import" }];
  if (data === null) {
    return (
      <>
        <PageHeader title="Mail import" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn&apos;t include importing mail.</p>
      </>
    );
  }
  return (
    <>
      <PageHeader title={`Import into ${data.address}`} breadcrumbs={crumbs} />
      <ImportDetail accountId={accountId} initial={toWire(data)} />
    </>
  );
}
