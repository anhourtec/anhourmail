// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { platformAuditPage } from "@anhourmail/core/audit";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditPager } from "@/components/audit/audit-pager";
import { AuditTable } from "@/components/audit/audit-table";
import { AREA_OPTIONS, readAuditParams } from "@/server/audit-page";
import { auditRows } from "@/server/audit-rows";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Platform audit" };

const ACTORS = [
  { value: "staff", label: "Anhourtec staff" },
  { value: "user", label: "Customers" },
  { value: "system", label: "System" },
  { value: "anonymous", label: "Signed-out visitors" },
];

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  if (!can(actor, "platform.audit.read")) notFound();
  const { filters, current, paged } = readAuditParams(await searchParams);
  const page = await platformAuditPage(container().deps, actor, filters);
  const path = "/platform/audit";

  return (
    <>
      <PageHeader
        title="Platform audit"
        description="Staff actions, platform settings, sign-ups and refused requests from outside any account. Entries can't be edited or deleted."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Platform audit" }]}
      />
      <AuditFilters action={path} areas={AREA_OPTIONS} actors={ACTORS} current={current} />
      <AuditTable rows={auditRows(page.entries)} />
      <AuditPager path={path} filters={current} paged={paged} nextBefore={page.nextBefore} />
    </>
  );
}
