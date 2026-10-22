// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import { GB, getMailbox } from "@anhourmail/core/mailboxes";
import { MAILBOX_DELETE_GRACE_DAYS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { DeleteMailbox, RestoreMailbox, SuspendMailbox } from "@/components/mailboxes/mailbox-lifecycle";
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
  const canManage = can(actor, "mailbox.manage", accountId);
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
          <dd className="flex flex-col items-start gap-1">
            <MailboxStatus status={m.status} applyFailed={m.applyFailed} />
            {m.status === "deleting" && m.purgeAfter && (
              <span className="am-micro am-num">Restorable until {dateFmt.format(new Date(m.purgeAfter))}</span>
            )}
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
      {canManage && m.lifecycleLocked && (
        <p className="am-small max-w-prose rounded-xl border px-4 py-3">
          This mailbox belongs to an owner or an admin, so only an owner can suspend, delete or restore it.
        </p>
      )}
      {canManage && !m.lifecycleLocked && m.status === "deleting" && (
        <section aria-labelledby="restore" className="flex flex-col gap-3">
          <h2 id="restore" className="am-h3">
            Being deleted
          </h2>
          <RestoreMailbox
            accountId={accountId}
            mailboxId={m.id}
            purgeOn={m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : "the end of its grace period"}
            applyFailed={m.applyFailed}
          />
        </section>
      )}
      {canManage && m.status !== "deleting" && (
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
      {canManage && !m.lifecycleLocked && m.status !== "deleting" && (
        <>
          <section aria-labelledby="access" className="flex flex-col gap-3">
            <h2 id="access" className="am-h3">
              Access
            </h2>
            <SuspendMailbox
              accountId={accountId}
              mailboxId={m.id}
              suspended={m.status === "suspended"}
              applyFailed={m.applyFailed}
            />
          </section>
          <section aria-labelledby="delete" className="flex flex-col gap-3 border-t pt-8">
            <h2 id="delete" className="am-h3">
              Delete this mailbox
            </h2>
            <DeleteMailbox
              accountId={accountId}
              mailboxId={m.id}
              address={m.address}
              graceDays={MAILBOX_DELETE_GRACE_DAYS}
            />
          </section>
        </>
      )}
    </>
  );
}
