// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { can } from "@anhourmail/core";
import { accountDeletionDetails, listExports } from "@anhourmail/core/data";
import { ACCOUNT_DELETION_GRACE_DAYS, DATA_EXPORT } from "@anhourmail/shared/data-lifecycle";
import { PageHeader } from "@anhourmail/ui/page-header";

import { DeleteAccount } from "@/components/data/delete-account";
import { ExportPanel } from "@/components/data/export-panel";
import { exportRows } from "@/components/data/rows";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Account settings" };

const dayFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" });

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="am-h3">
          {title}
        </h2>
        <p className="am-small max-w-[80ch]">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Account settings for Owners (ADR-0025): export the account's data (a worker-built archive, downloaded after a step-up)
 * and delete the account (a grace period, cancellable). Mail itself is exported by each person from the webmail.
 */
export default async function AccountSettingsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const deps = container().deps;
  const exports = await forPage(() => listExports(deps, actor, { kind: "account", accountId }));
  const deletion = await forPage(() => accountDeletionDetails(deps, actor, accountId));
  const name = (await deps.uow.run((r) => r.accounts.get(accountId)))?.name;
  if (name === undefined) notFound();
  const crumbs = [{ label: "Home", href: "/" }, { label: "Account settings" }];
  return (
    <>
      <PageHeader
        title="Account settings"
        description="Take a copy of this account's data, or delete the account."
        breadcrumbs={crumbs}
      />
      <Section
        id="export"
        title="Export your data"
        description="A ZIP of the account's settings, people, domains and their DNS records, mailboxes, aliases, app password names and the audit log, as JSON and CSV. It doesn't hold mail: each person exports their own mail and contacts from the webmail (Settings, Export)."
      >
        {exports === null ? (
          <p className="am-body">Only an Owner can export this account&apos;s data.</p>
        ) : (
          <ExportPanel
            endpoint={`/api/accounts/${encodeURIComponent(accountId)}/exports`}
            rows={exportRows(exports)}
            keepDays={DATA_EXPORT.keepDays}
          />
        )}
      </Section>
      {can(actor, "account.delete", accountId) || deletion ? (
        <Section
          id="delete"
          title="Delete account"
          description={`Deleting the account suspends its mailboxes at once and removes everything in it after ${String(ACCOUNT_DELETION_GRACE_DAYS)} days. You can cancel until then.`}
        >
          <DeleteAccount
            accountId={accountId}
            accountName={name}
            graceDays={ACCOUNT_DELETION_GRACE_DAYS}
            pending={
              deletion
                ? {
                    deleteAfter: dayFmt.format(deletion.deleteAfter),
                    canCancel: deletion.canCancel,
                    started: deletion.started,
                  }
                : null
            }
          />
        </Section>
      ) : null}
    </>
  );
}
