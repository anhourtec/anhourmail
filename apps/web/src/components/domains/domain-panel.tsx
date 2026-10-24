// SPDX-License-Identifier: AGPL-3.0-only
import type { CatchAllOptions, CatchAllView, CheckedRecord, DomainView, RecordState } from "@anhourmail/core/domains";
import { ListChecks, Trash2 } from "lucide-react";

import { DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { StatusText, type Tone } from "../console/status-text";
import { CopyValue } from "../copy-value";
import { CatchAllForm } from "./catch-all-form";
import { CheckButton } from "./check-button";
import { DomainStatus } from "./domain-status";
import { RemoveDomain } from "./remove-domain";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

const STATE: Record<RecordState, { label: string; tone: Tone }> = {
  ok: { label: "Found", tone: "success" },
  missing: { label: "Missing", tone: "warning" },
  wrong: { label: "Different value", tone: "danger" },
  error: { label: "Couldn't check", tone: "neutral" },
};

function RecordRow({ r }: { r: CheckedRecord }) {
  // A missing recommended record isn't a problem to fix now: say "Not set", not a warning.
  const state = !r.required && r.state === "missing" ? { label: "Not set", tone: "neutral" as const } : STATE[r.state];
  return (
    <li className="flex flex-col gap-3 border-b py-4 xl:grid xl:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.6fr)_8.5rem] xl:items-start xl:gap-4">
      <div className="flex items-center gap-2 xl:flex-col xl:items-start">
        <span className="font-mono font-medium text-[14px]">{r.type}</span>
        <span className="am-micro">{r.required ? "Required" : "Recommended"}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="am-micro xl:hidden">Name</span>
        <CopyValue value={r.name} label={`${r.type} name`} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="am-micro xl:hidden">
          Value{r.priority !== undefined && r.type === "MX" ? " (priority)" : ""}
        </span>
        <CopyValue
          value={r.type === "MX" ? `${String(r.priority ?? 10)} ${r.value}` : r.value}
          label={`${r.type} value`}
        />
        <span className="am-small">{r.why}</span>
        {r.problem !== undefined && <span className="am-small text-destructive">{r.problem}</span>}
        {r.state === "wrong" && r.found.length > 0 && (
          <span className="am-micro break-all">Found instead: {r.found.join(", ")}</span>
        )}
      </div>
      <div>
        <StatusText tone={state.tone}>{state.label}</StatusText>
      </div>
    </li>
  );
}

/**
 * The domain details panel: header (initials, name, status, "Check now"), then Overview (fields and removal) and
 * DNS records (required and recommended, with live state). A pending domain opens on its records.
 */
export function DomainPanel({
  accountId,
  domain,
  records,
  live,
  canManage,
  catchAll,
  tab,
}: {
  accountId: string;
  domain: DomainView;
  records: CheckedRecord[];
  /** False when live checks are paused by the rate limit: records show without their state. */
  live: boolean;
  canManage: boolean;
  /** The domain's catch-all, with the mailboxes it can point at for people who manage domains. */
  catchAll: (CatchAllView & { options: CatchAllOptions | null }) | null;
  tab?: string | null;
}) {
  const manage = canManage && domain.status !== "removing";
  const required = records.filter((r) => r.required);
  const recommended = records.filter((r) => !r.required);
  const found = required.filter((r) => r.state === "ok").length;
  const explain =
    domain.status === "pending_dns"
      ? "Add the required records at your DNS provider. We check again every few minutes for the first week."
      : domain.status === "removing"
        ? "This domain is being removed."
        : "Mail for this domain arrives at AnhourMail.";

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: (
        <>
          <FieldGrid>
            <Field label="Domain">
              <CopyValue value={domain.name} label="domain name" />
            </Field>
            <Field label="Mail">{explain}</Field>
            <Field
              label="Required DNS records"
              manage={
                <TabLink tab="records" plain>
                  View DNS records
                </TabLink>
              }
            >
              {live ? (
                <span className="am-num">
                  {found} of {required.length} in place
                </span>
              ) : (
                "Not checked just now"
              )}
            </Field>
            {catchAll && domain.status === "active" && (
              <Field label="Catch-all">
                {catchAll.mailbox ? (
                  <span>
                    On, to <span className="font-mono">{catchAll.mailbox.address}</span>
                  </span>
                ) : (
                  "Off"
                )}
              </Field>
            )}
            <Field label="Added">
              <span className="am-num">{dateFmt.format(new Date(domain.createdAt))}</span>
            </Field>
          </FieldGrid>
          {manage && catchAll?.domainActive && (
            <PanelSection title="Catch-all">
              {catchAll.planAllowed && catchAll.options ? (
                <CatchAllForm
                  accountId={accountId}
                  domainId={domain.id}
                  domain={domain.name}
                  current={catchAll.mailbox}
                  mailboxes={catchAll.options.mailboxes}
                />
              ) : (
                <p className="am-small max-w-prose">
                  A catch-all sends mail for addresses that don&apos;t exist to one mailbox. It&apos;s part of the Plus
                  and Supporter plans.
                </p>
              )}
            </PanelSection>
          )}
          {manage && (
            <PanelSection title="Remove this domain">
              <RemoveDomain accountId={accountId} domainId={domain.id} name={domain.name} />
            </PanelSection>
          )}
        </>
      ),
    },
    {
      id: "records",
      label: "DNS records",
      content: (
        <div className="flex flex-col gap-8">
          {!live && (
            <p className="am-small rounded-lg border px-4 py-3">
              Live checks are paused for a few minutes because this domain was opened many times. Press Check now when
              you&apos;re ready.
            </p>
          )}
          {[
            { title: "Required records", list: required, id: "required" },
            { title: "Recommended records", list: recommended, id: "recommended" },
          ].map((g) => (
            <section key={g.id} aria-labelledby={`records-${g.id}`} className="flex flex-col gap-1">
              <h3 id={`records-${g.id}`} className="am-h4">
                {g.title}
              </h3>
              <ul className="border-t">
                {g.list.map((r) => (
                  <RecordRow key={`${r.type}-${r.name}-${r.value}`} r={r} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        initials={initialsOf(domain.name)}
        name={domain.name}
        mono
        status={<DomainStatus d={domain} />}
        actions={
          <>
            {manage && <CheckButton accountId={accountId} domainId={domain.id} inline />}
            <TabLink tab="records">
              <ListChecks aria-hidden />
              DNS records
            </TabLink>
            {manage && (
              <TabLink tab="overview">
                <Trash2 aria-hidden />
                Remove
              </TabLink>
            )}
          </>
        }
      />
      <DetailTabs
        key={domain.id}
        tabs={tabs}
        initial={tab ?? (domain.status === "pending_dns" ? "records" : "overview")}
      />
    </div>
  );
}
