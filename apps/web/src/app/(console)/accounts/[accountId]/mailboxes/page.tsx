// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { GB, listMailboxes, mailboxOptions } from "@anhourmail/core/mailboxes";
import { PageHeader } from "@anhourmail/ui/page-header";

import { CreateMailboxForm } from "@/components/mailboxes/create-mailbox-form";
import { MailboxStatus } from "@/components/mailboxes/mailbox-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Mailboxes" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

export default async function MailboxesPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const deps = container().deps;
  const canManage = can(actor, "mailbox.manage", accountId);
  const data = await forPage(async () => ({
    mailboxes: await listMailboxes(deps, actor, accountId),
    options: canManage ? await mailboxOptions(deps, actor, accountId) : null,
  }));
  const crumbs = [{ label: "Overview", href: "/" }, { label: "Mailboxes" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Mailboxes" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include mailboxes. Ask an owner if you need access.</p>
      </>
    );
  }
  const { mailboxes, options } = data;

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Each mailbox is an address with its own storage. Aliases point more addresses at it."
        breadcrumbs={crumbs}
      />
      {options &&
        (options.domains.length === 0 ? (
          <p className="am-body rounded-xl border px-4 py-3">
            Mailboxes live on your own domain.{" "}
            <Link href={`/accounts/${accountId}/domains`} className="underline underline-offset-2">
              Add and verify a domain
            </Link>{" "}
            first.
          </p>
        ) : options.remaining > 0 ? (
          <CreateMailboxForm accountId={accountId} options={options} />
        ) : (
          <p className="am-small">This account has the most mailboxes it can have.</p>
        ))}
      {mailboxes.length === 0 ? (
        <p className="am-small">No mailboxes yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left">
            <thead className="border-b bg-muted/50">
              <tr>
                <th scope="col" className="am-mono px-4 py-2.5 font-normal">
                  Address
                </th>
                <th scope="col" className="am-mono hidden px-4 py-2.5 font-normal md:table-cell">
                  Belongs to
                </th>
                <th scope="col" className="am-mono hidden px-4 py-2.5 font-normal sm:table-cell">
                  Storage
                </th>
                <th scope="col" className="am-mono px-4 py-2.5 font-normal">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {mailboxes.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/accounts/${accountId}/mailboxes/${m.id}`}
                      className="am-code break-all underline-offset-2 hover:underline"
                    >
                      {m.address}
                    </Link>
                  </td>
                  <td className="am-small hidden px-4 py-3 md:table-cell">{m.owner?.email ?? "—"}</td>
                  <td className="am-small am-num hidden px-4 py-3 sm:table-cell">{m.quotaBytes / GB} GB</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <MailboxStatus status={m.status} applyFailed={m.applyFailed} />
                      {m.status === "deleting" && m.purgeAfter && (
                        <span className="am-micro am-num">
                          Restorable until {dateFmt.format(new Date(m.purgeAfter))}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
