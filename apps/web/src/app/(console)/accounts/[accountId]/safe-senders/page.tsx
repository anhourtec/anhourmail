// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { listAccountSafeSenders } from "@anhourmail/core/webmail";
import { ACCOUNT_SAFE_SENDERS } from "@anhourmail/shared/senders";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AccountSafeSenders } from "@/components/safe-senders/account-safe-senders";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Safe senders" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * The account-wide Safe senders list (ADR-0032 §1): Owners and User Administrators add and remove addresses and
 * domains every mailbox in the account trusts; Read-only sees the list.
 */
export default async function SafeSendersPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => listAccountSafeSenders(container().deps, actor, { accountId }));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Safe senders" }];
  const docs = `${env().SITE_URL.replace(/\/$/, "")}/docs/safe-senders`;
  return (
    <>
      <PageHeader
        title="Safe senders"
        description="Addresses and domains everyone in this account trusts. Their images load by themselves when we can confirm who sent the message, and their mail isn't moved to Junk by the “Only trust my contacts and safe senders” setting."
        breadcrumbs={crumbs}
      />
      {data === null ? (
        <p className="am-body">Your role in this account doesn&apos;t include Safe senders.</p>
      ) : (
        <section aria-labelledby="safe-list" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="safe-list" className="am-h3">
              Account safe senders
            </h2>
            <p className="am-small max-w-[80ch]">
              {`${String(data.entries.length)} of ${String(ACCOUNT_SAFE_SENDERS.maxEntries)}. People see these in their own Junk and blocked senders settings, marked “Added by your organisation”. Anyone they block themselves stays blocked.`}
            </p>
          </div>
          <AccountSafeSenders
            accountId={accountId}
            canManage={data.canManage}
            maxEntries={data.limits.maxEntries}
            rows={data.entries.map((e) => ({
              id: e.id,
              entry: e.entry,
              kind: e.kind,
              added: dateFmt.format(e.createdAt),
            }))}
          />
          <p className="am-small">
            More in the{" "}
            <a href={docs} className="text-primary underline-offset-2 hover:underline">
              Safe senders guide
            </a>
            .
          </p>
        </section>
      )}
    </>
  );
}
