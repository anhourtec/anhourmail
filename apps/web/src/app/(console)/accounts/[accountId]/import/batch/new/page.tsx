// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { IMPORT } from "@anhourmail/shared/import";
import { MAX_MAILBOXES } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { BatchUpload } from "@/components/imports/batch-upload";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Import many mailboxes" };

/** The admins' batch migration (ADR-0030 §8): a CSV with one row per mailbox (the layout checks the permission). */
export default async function BatchNewPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const crumbs = [
    { label: "Home", href: "/" },
    { label: "Import mail", href: base },
    { label: "Import many mailboxes" },
  ];
  const docs = `${env().SITE_URL.replace(/\/$/, "")}/docs/import/many-mailboxes`;
  return (
    <>
      <PageHeader
        title="Import many mailboxes"
        description={`Moving a whole team? Start an import for up to ${String(MAX_MAILBOXES)} mailboxes at once from one CSV file.`}
        breadcrumbs={crumbs}
      />
      <BatchUpload accountId={accountId} maxKb={IMPORT.batchMaxBytes / 1024} />
      <p className="am-small">
        Column by column, with examples:{" "}
        <a href={docs} className="text-primary underline-offset-2 hover:underline">
          importing many mailboxes guide
        </a>
        .
      </p>
    </>
  );
}
