// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import {
  type CheckedRecord,
  domainAllowance,
  getCatchAll,
  getDomain,
  inspectDomain,
  listDomains,
} from "@anhourmail/core/domains";
import { checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";
import { PageHeader } from "@anhourmail/ui/page-header";

import { UrlFlyout } from "@/components/console/flyout";
import { AddDomainForm } from "@/components/domains/add-domain-form";
import { DomainList } from "@/components/domains/domain-list";
import { DomainPanel } from "@/components/domains/domain-panel";
import { domainState } from "@/components/domains/domain-status";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { platform } from "@/server/platform";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "Domains" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

/**
 * Domains (console page template). `?domain=<id>` opens the details panel with the DNS records (checked live, within
 * the person's `dnsVerify` budget), `?new=1` the "Add a domain" panel. `/domains/<id>` redirects here.
 */
export default async function DomainsPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { accountId } = await params;
  const sp = await searchParams;
  const actor = await requireUser();
  const deps = container().deps;
  const openId = param(sp, "domain");
  // Live lookups when a panel opens share the `dnsVerify` budget (per person); over it, the panel shows the records
  // without their live state rather than querying DNS on every reload. The domain is read (scope checked) first, so
  // an id from another account is a 404 without spending the budget.
  const openDomain = async (id: string) => {
    const { records, ...domain } = await getDomain(deps, actor, accountId, id);
    const live = (await checkRateLimit(container().counter, "dnsInspect", LIMITS.dnsVerify, `user:${actor.userId}`))
      .allowed;
    if (live) return { ...(await inspectDomain(deps, container().dns, actor, accountId, id)), live };
    return {
      domain,
      records: records.map((r): CheckedRecord => ({ ...r, fqdn: r.name, state: "error", found: [] })),
      live,
    };
  };
  const data = await forPage(async () => ({
    domains: await listDomains(deps, actor, accountId),
    allowance: await domainAllowance(deps, actor, accountId),
    open: openId ? await openDomain(openId) : null,
    catchAll: openId ? await getCatchAll(deps, actor, accountId, openId) : null,
  }));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Domains" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Domains" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include domains. Ask an owner if you need access.</p>
      </>
    );
  }
  const canManage = can(actor, "domain.manage", accountId);
  const { domains, allowance, open, catchAll } = data;
  const path = `/accounts/${accountId}/domains`;
  const canAdd = canManage && allowance.allowed && domains.length < allowance.max;

  return (
    <>
      <PageHeader
        title="Domains"
        description="Use your own domain for addresses and aliases. Each domain needs a few DNS records before it works."
        breadcrumbs={crumbs}
      />
      {canManage && !allowance.allowed && (
        <p className="am-body rounded-lg border px-4 py-3">
          Custom domains are part of the Plus and Supporter plans. Free accounts use an @{platform().freeAddressDomain}{" "}
          address.
        </p>
      )}
      {canManage && allowance.allowed && !canAdd && (
        <p className="am-small">This account has the most domains it can have ({allowance.max}).</p>
      )}
      <DomainList
        accountId={accountId}
        rows={domains.map((d) => ({
          id: d.id,
          name: d.name,
          state: domainState(d),
          added: dateFmt.format(new Date(d.createdAt)),
          addedAt: new Date(d.createdAt).getTime(),
        }))}
        openId={open?.domain.id ?? null}
        createHref={canAdd ? `${path}?new=1` : null}
        docsHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/custom-domain`}
      />

      {open && (
        <UrlFlyout label={open.domain.name} closeHref={path}>
          <DomainPanel
            accountId={accountId}
            domain={open.domain}
            records={open.records}
            live={open.live}
            canManage={canManage}
            catchAll={catchAll}
            tab={param(sp, "tab")}
          />
        </UrlFlyout>
      )}
      {canAdd && param(sp, "new") === "1" && (
        <UrlFlyout label="Add a domain" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Add a domain</h2>
              <p className="am-small">Addresses and aliases at a domain you own, once it&apos;s verified.</p>
            </div>
            <AddDomainForm accountId={accountId} />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
