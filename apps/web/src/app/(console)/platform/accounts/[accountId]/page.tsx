// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { can, NotFoundError } from "@anhourmail/core";
import { GB } from "@anhourmail/core/mailboxes";
import { viewAccount } from "@anhourmail/core/platform";
import { PLANS } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { requestIdFrom } from "@anhourmail/server/request-context";
import { PageHeader } from "@anhourmail/ui/page-header";

import { CopyValue } from "@/components/copy-value";
import { MailboxStatus } from "@/components/mailboxes/mailbox-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { clientIp } from "@anhourmail/server/client-ip";

export const metadata: Metadata = { title: "Customer account" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
const th = "am-mono px-4 py-2.5 font-normal";

const DOMAIN_STATUS: Record<string, { text: string; tone: string }> = {
  pending_dns: { text: "Waiting for DNS", tone: "info" },
  active: { text: "Active", tone: "success" },
  removing: { text: "Removing", tone: "warning" },
};

export default async function CustomerAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  if (!can(actor, "platform.accounts.read")) notFound();
  const h = await headers();
  let detail;
  try {
    // Opening the page is recorded in the account's own audit log (rule 49).
    detail = await viewAccount(container().deps, actor, accountId, {
      requestId: requestIdFrom(h),
      ip: clientIp(h),
      userAgent: h.get("user-agent"),
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { summary, people, domains, mailboxes, pendingInvites } = detail;

  return (
    <>
      <PageHeader
        title={summary.name}
        breadcrumbs={[
          { label: "Overview", href: "/" },
          { label: "Customer accounts", href: "/platform/accounts" },
          { label: summary.name },
        ]}
      />
      <p className="am-small max-w-prose rounded-xl border px-4 py-3">
        Opening this page is recorded in the account&apos;s audit log, where its admins see it as Anhourtec staff.
      </p>
      <dl className="grid gap-x-8 gap-y-4 rounded-xl border p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Plan</dt>
          <dd className="am-body">{PLANS[summary.plan].name}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Status</dt>
          <dd>
            <span className={`am-status am-status--${summary.status === "active" ? "success" : "warning"}`}>
              {summary.status === "active" ? "Active" : summary.status}
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="am-micro">Created</dt>
          <dd className="am-body am-num">{dateFmt.format(summary.createdAt)}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="am-micro">Account id</dt>
          <dd>
            <CopyValue value={summary.id} label="account id" />
          </dd>
        </div>
      </dl>

      <section aria-labelledby="people" className="flex flex-col gap-3">
        <h2 id="people" className="am-h3">
          People <span className="am-small am-num font-normal">({people.length})</span>
        </h2>
        {pendingInvites > 0 && (
          <p className="am-small am-num">
            {pendingInvites === 1 ? "1 pending invite" : `${String(pendingInvites)} pending invites`}
          </p>
        )}
        {people.length === 0 ? (
          <p className="am-small">Nobody.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th scope="col" className={th}>
                    Person
                  </th>
                  <th scope="col" className={th}>
                    Role
                  </th>
                  <th scope="col" className={`${th} hidden sm:table-cell`}>
                    Status
                  </th>
                  <th scope="col" className={`${th} hidden md:table-cell`}>
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {people.map((p) => (
                  <tr key={p.userId}>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="am-body">{p.name}</span>
                        <span className="am-code break-all text-muted-foreground">{p.email}</span>
                      </div>
                    </td>
                    <td className="am-small px-4 py-3">{ROLE_LABELS[`account:${p.role}`]}</td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className={`am-status am-status--${p.suspended ? "neutral" : "success"}`}>
                        {p.suspended ? "Suspended" : "Active"}
                      </span>
                    </td>
                    <td className="am-small am-num hidden px-4 py-3 md:table-cell">{dateFmt.format(p.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="domains" className="flex flex-col gap-3">
        <h2 id="domains" className="am-h3">
          Domains <span className="am-small am-num font-normal">({domains.length})</span>
        </h2>
        {domains.length === 0 ? (
          <p className="am-small">No custom domains.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {domains.map((d) => {
              const st = DOMAIN_STATUS[d.status] ?? { text: d.status, tone: "neutral" };
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <code className="am-code break-all">{d.name}</code>
                  <span className={`am-status am-status--${st.tone}`}>{st.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="mailboxes" className="flex flex-col gap-3">
        <h2 id="mailboxes" className="am-h3">
          Mailboxes <span className="am-small am-num font-normal">({mailboxes.length})</span>
        </h2>
        {mailboxes.length === 0 ? (
          <p className="am-small">No mailboxes.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th scope="col" className={th}>
                    Address
                  </th>
                  <th scope="col" className={`${th} hidden sm:table-cell`}>
                    Storage
                  </th>
                  <th scope="col" className={th}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {mailboxes.map((m) => (
                  <tr key={m.id}>
                    <td className="am-code break-all px-4 py-3">{m.address}</td>
                    <td className="am-small am-num hidden px-4 py-3 sm:table-cell">{m.quotaBytes / GB} GB</td>
                    <td className="px-4 py-3">
                      <MailboxStatus status={m.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
