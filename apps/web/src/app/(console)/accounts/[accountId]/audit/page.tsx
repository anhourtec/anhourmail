// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import { accountAuditPage } from "@anhourmail/core/audit";
import { listPeople } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditPager } from "@/components/audit/audit-pager";
import { AuditTable } from "@/components/audit/audit-table";
import { AREA_OPTIONS, readAuditParams } from "@/server/audit-page";
import { auditRows } from "@/server/audit-rows";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Audit log" };

export default async function AccountAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { accountId } = await params;
  const actor = await requireUser();
  const { filters, current, paged } = readAuditParams(await searchParams);
  const deps = container().deps;
  const data = await forPage(async () => ({
    page: await accountAuditPage(deps, actor, accountId, filters),
    people: can(actor, "member.read", accountId) ? (await listPeople(deps, actor, accountId)).members : [],
  }));
  const crumbs = [{ label: "Overview", href: "/" }, { label: "Audit log" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Audit log" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include the audit log. Ask an owner if you need it.</p>
      </>
    );
  }
  const path = `/accounts/${accountId}/audit`;
  const actors = [
    { value: "staff", label: "Anhourtec staff" },
    { value: "system", label: "System" },
    ...data.people.map((p) => ({ value: p.userId, label: p.email })),
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change in this account: who made it, when and from which network. Entries can't be edited or deleted, and anything Anhourtec staff do here is listed too."
        breadcrumbs={crumbs}
      />
      <AuditFilters action={path} areas={AREA_OPTIONS} actors={actors} current={current} />
      <AuditTable rows={auditRows(data.page.entries)} />
      <AuditPager path={path} filters={current} paged={paged} nextBefore={data.page.nextBefore} />
    </>
  );
}
