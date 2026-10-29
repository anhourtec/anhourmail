// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { listExports, loginDeletionPlan, type LoginDeletionBlocker } from "@anhourmail/core/data";
import { DATA_EXPORT } from "@anhourmail/shared/data-lifecycle";
import { PageHeader } from "@anhourmail/ui/page-header";

import { StatusText } from "@/components/console/status-text";
import { DeleteLogin } from "@/components/data/delete-login";
import { ExportPanel } from "@/components/data/export-panel";
import { exportRows } from "@/components/data/rows";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Your data" };

const BLOCKER: Record<LoginDeletionBlocker, string> = {
  staff: "You hold an Anhourtec staff role. A Global Administrator removes it first.",
  mailboxes:
    "A mailbox in this account is yours. Ask its admins to remove you from the account; the mailbox stays with it.",
  sole_owner:
    "You're the only Owner and it still has mailboxes, domains or other people. Delete the account in its Account settings, or make someone else an Owner.",
  deleting: "Anhourtec has suspended this account, so it can't be deleted yet.",
};

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
 * The person's own data (ADR-0025): export it (profile, memberships, own mailboxes' settings, sign-in security and
 * activity; downloaded after a step-up) and delete their console login when no account depends on it. Not while staff
 * act as someone (the services refuse; the page says so).
 */
export default async function YourDataPage() {
  const actor = await requireUser();
  const deps = container().deps;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Your data" }];
  const exports = await forPage(() => listExports(deps, actor, { kind: "personal" }));
  const plan = await forPage(() => loginDeletionPlan(deps, actor));
  if (exports === null || plan === null) {
    return (
      <>
        <PageHeader title="Your data" breadcrumbs={crumbs} />
        <p className="am-body">Your data can&apos;t be exported or deleted while you&apos;re acting as someone.</p>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Your data"
        description="Take a copy of what AnhourMail keeps about you, or delete your console login."
        breadcrumbs={crumbs}
      />
      <Section
        id="export"
        title="Export your data"
        description="A ZIP of your profile, the accounts you belong to, your mailboxes' settings and aliases, your sign-in methods and sessions, and your activity, as JSON and CSV. Mail and contacts are exported from the webmail (Settings, Export)."
      >
        <ExportPanel endpoint="/api/me/exports" rows={exportRows(exports)} keepDays={DATA_EXPORT.keepDays} />
      </Section>
      <Section
        id="delete"
        title="Delete your login"
        description="Deletes your console sign-in and the details we keep about you. Your accounts' mail stays with them."
      >
        {plan.allowed ? (
          <DeleteLogin email={actor.email} accountsDeleted={plan.accountsDeleted.map((a) => a.accountName)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {plan.blockers.map((b, i) => (
              <li key={`${String(i)}-${b.reason}`} className="flex flex-col gap-0.5">
                <StatusText tone="warning">
                  {b.accountName ? <span className="font-mono">{b.accountName}</span> : "Your login"}
                </StatusText>
                <span className="am-small pl-[22px]">{BLOCKER[b.reason]}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
