// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import { GB, getMailbox } from "@anhourmail/core/mailboxes";
import { PageHeader } from "@anhourmail/ui/page-header";

import { MailboxStatus } from "@/components/mailboxes/mailbox-status";
import { QuotaForm } from "@/components/mailboxes/quota-form";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Mailbox" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

export default async function MailboxPage({ params }: { params: Promise<{ accountId: string; mailboxId: string }> }) {
  const { accountId, mailboxId } = await params;
  const actor = await requireUser();
  const m = await forPage(() => getMailbox(container().deps, actor, accountId, mailboxId));
  const crumbs = [
    { label: "Overview", href: "/" },
    { label: "Mailboxes", href: `/accounts/${accountId}/mailboxes` },
  ];
  if (!m) {
    return (
      <>
        <PageHeader title="Mailbox" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include mailboxes.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title={m.address} breadcrumbs={[...crumbs, { label: m.address }]} />
      <dl className="grid gap-x-8 gap-y-4 rounded-xl border p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Status</dt>
          <dd>
            <MailboxStatus status={m.status} />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Belongs to</dt>
          <dd className="am-body break-all">{m.owner?.email ?? "Nobody yet"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Storage</dt>
          <dd className="am-body am-num">{m.quotaBytes / GB} GB</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Created</dt>
          <dd className="am-body am-num">{dateFmt.format(new Date(m.createdAt))}</dd>
        </div>
      </dl>
      {can(actor, "mailbox.manage", accountId) && (
        <section aria-labelledby="storage" className="flex flex-col gap-3">
          <h2 id="storage" className="am-h3">
            Storage
          </h2>
          <QuotaForm
            accountId={accountId}
            mailboxId={m.id}
            currentGb={m.quotaBytes / GB}
            maxGb={m.maxQuotaBytes / GB}
          />
        </section>
      )}
    </>
  );
}
