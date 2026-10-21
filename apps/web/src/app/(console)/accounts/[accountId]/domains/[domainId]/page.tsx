// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import { type CheckedRecord, getDomain, inspectDomain, type RecordState } from "@anhourmail/core/domains";
import { checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";
import { PageHeader } from "@anhourmail/ui/page-header";

import { CopyValue } from "@/components/copy-value";
import { CheckButton } from "@/components/domains/check-button";
import { DomainStatus } from "@/components/domains/domain-status";
import { RemoveDomain } from "@/components/domains/remove-domain";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Domain" };

const STATE: Record<RecordState, { label: string; tone: string }> = {
  ok: { label: "Found", tone: "success" },
  missing: { label: "Missing", tone: "warning" },
  wrong: { label: "Different value", tone: "danger" },
  error: { label: "Couldn't check", tone: "neutral" },
};

function RecordRow({ r }: { r: CheckedRecord }) {
  // A missing recommended record isn't a problem to fix now: say "Not set", not a warning.
  const state = !r.required && r.state === "missing" ? { label: "Not set", tone: "neutral" } : STATE[r.state];
  return (
    <li className="flex flex-col gap-3 px-4 py-4 lg:grid lg:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1.6fr)_9rem] lg:items-start lg:gap-4">
      <div className="flex items-center gap-2 lg:flex-col lg:items-start">
        <span className="am-code">{r.type}</span>
        <span className="am-micro">{r.required ? "Required" : "Recommended"}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="am-micro lg:hidden">Name</span>
        <CopyValue value={r.name} label={`${r.type} name`} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="am-micro lg:hidden">
          Value{r.priority !== undefined && r.type === "MX" ? " (priority)" : ""}
        </span>
        <CopyValue
          value={r.type === "MX" ? `${String(r.priority ?? 10)} ${r.value}` : r.value}
          label={`${r.type} value`}
        />
        <span className="am-small">{r.why}</span>
        {r.state === "wrong" && r.found.length > 0 && (
          <span className="am-micro break-all">Found instead: {r.found.join(", ")}</span>
        )}
      </div>
      <div>
        <span className={`am-status am-status--${state.tone}`}>{state.label}</span>
      </div>
    </li>
  );
}

export default async function DomainPage({ params }: { params: Promise<{ accountId: string; domainId: string }> }) {
  const { accountId, domainId } = await params;
  const actor = await requireUser();
  // Live lookups on page load share the `dnsVerify` budget (per person); over it, the page shows the records
  // without their live state rather than querying DNS on every reload.
  const live = (await checkRateLimit(container().counter, "dnsInspect", LIMITS.dnsVerify, `user:${actor.userId}`))
    .allowed;
  const data = await forPage(async () =>
    live
      ? inspectDomain(container().deps, container().dns, actor, accountId, domainId)
      : getDomain(container().deps, actor, accountId, domainId).then(({ records, ...domain }) => ({
          domain,
          records: records.map((r): CheckedRecord => ({ ...r, fqdn: r.name, state: "error", found: [] })),
        })),
  );
  const crumbs = [
    { label: "Overview", href: "/" },
    { label: "Domains", href: `/accounts/${accountId}/domains` },
  ];
  if (!data) {
    return (
      <>
        <PageHeader title="Domain" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include domains.</p>
      </>
    );
  }
  const { domain, records } = data;
  const canManage = can(actor, "domain.manage", accountId) && domain.status !== "removing";
  const required = records.filter((r) => r.required);
  const recommended = records.filter((r) => !r.required);

  return (
    <>
      <PageHeader
        title={domain.name}
        breadcrumbs={[...crumbs, { label: domain.name }]}
        actions={canManage ? <CheckButton accountId={accountId} domainId={domain.id} /> : undefined}
      />
      {!live && (
        <p className="am-small rounded-xl border px-4 py-3">
          Live checks are paused for a few minutes because this page was opened many times. Press Check now when you're
          ready.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <DomainStatus d={domain} />
        <span className="am-small">
          {domain.status === "pending_dns"
            ? "Add the required records at your DNS provider. We check again every few minutes for the first week."
            : domain.status === "removing"
              ? "This domain is being removed."
              : "Mail for this domain arrives at AnhourMail."}
        </span>
      </div>

      {[
        { title: "Required records", list: required, id: "required" },
        { title: "Recommended records", list: recommended, id: "recommended" },
      ].map((g) => (
        <section key={g.id} aria-labelledby={`records-${g.id}`} className="flex flex-col gap-3">
          <h2 id={`records-${g.id}`} className="am-h3">
            {g.title}
          </h2>
          <ul className="divide-y rounded-xl border">
            {g.list.map((r) => (
              <RecordRow key={`${r.type}-${r.name}-${r.value}`} r={r} />
            ))}
          </ul>
        </section>
      ))}

      {canManage && (
        <section aria-labelledby="remove" className="flex flex-col gap-3 border-t pt-8">
          <h2 id="remove" className="am-h3">
            Remove this domain
          </h2>
          <RemoveDomain accountId={accountId} domainId={domain.id} name={domain.name} />
        </section>
      )}
    </>
  );
}
