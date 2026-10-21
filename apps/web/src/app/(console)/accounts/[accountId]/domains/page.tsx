// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { domainAllowance, listDomains } from "@anhourmail/core/domains";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddDomainForm } from "@/components/domains/add-domain-form";
import { DomainStatus } from "@/components/domains/domain-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Domains" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

export default async function DomainsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const deps = container().deps;
  const data = await forPage(async () => ({
    domains: await listDomains(deps, actor, accountId),
    allowance: await domainAllowance(deps, actor, accountId),
  }));
  const crumbs = [{ label: "Overview", href: "/" }, { label: "Domains" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Domains" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include domains. Ask an owner if you need access.</p>
      </>
    );
  }
  const canManage = can(actor, "domain.manage", accountId);
  const { domains, allowance } = data;

  return (
    <>
      <PageHeader
        title="Domains"
        description="Use your own domain for addresses and aliases. Each domain needs a few DNS records before it works."
        breadcrumbs={crumbs}
      />
      {canManage &&
        (allowance.allowed ? (
          domains.length < allowance.max ? (
            <AddDomainForm accountId={accountId} />
          ) : (
            <p className="am-small">This account has the most domains it can have ({allowance.max}).</p>
          )
        ) : (
          <p className="am-body rounded-xl border px-4 py-3">
            Custom domains are part of the Plus and Supporter plans. Free accounts use an @anhourmail.com address.
          </p>
        ))}
      {domains.length === 0 ? (
        <p className="am-small">No domains yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left">
            <thead className="border-b bg-muted/50">
              <tr>
                <th scope="col" className="am-mono px-4 py-2.5 font-normal">
                  Domain
                </th>
                <th scope="col" className="am-mono px-4 py-2.5 font-normal">
                  Status
                </th>
                <th scope="col" className="am-mono hidden px-4 py-2.5 font-normal sm:table-cell">
                  Added
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {domains.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/accounts/${accountId}/domains/${d.id}`}
                      className="am-code underline-offset-2 hover:underline"
                    >
                      {d.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <DomainStatus d={d} />
                  </td>
                  <td className="am-small am-num hidden px-4 py-3 sm:table-cell">
                    {dateFmt.format(new Date(d.createdAt))}
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
