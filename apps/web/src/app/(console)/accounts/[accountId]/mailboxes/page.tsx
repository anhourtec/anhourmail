// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { GB, getMailbox, listMailboxes, mailboxOptions } from "@anhourmail/core/mailboxes";
import { MAILBOX_DELETE_GRACE_DAYS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { UrlFlyout } from "@/components/console/flyout";
import { CreateMailboxForm } from "@/components/mailboxes/create-mailbox-form";
import { MailboxList } from "@/components/mailboxes/mailbox-list";
import { MailboxPanel } from "@/components/mailboxes/mailbox-panel";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "Mailboxes" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

/**
 * Mailboxes (console page template). The details panel (`?mailbox=<id>`, optional `&tab=`) and the "Add a mailbox"
 * panel (`?new=1`) live in the URL so they can be linked, reloaded and closed with Back. The old
 * `/mailboxes/<id>` address redirects here.
 */
export default async function MailboxesPage({
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
  const canManage = can(actor, "mailbox.manage", accountId);
  const openId = param(sp, "mailbox");
  const data = await forPage(async () => ({
    mailboxes: await listMailboxes(deps, actor, accountId),
    options: canManage ? await mailboxOptions(deps, actor, accountId) : null,
    open: openId ? await getMailbox(deps, actor, accountId, openId) : null,
  }));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Mailboxes" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Mailboxes" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include mailboxes. Ask an owner if you need access.</p>
      </>
    );
  }
  const { mailboxes, options, open } = data;
  const path = `/accounts/${accountId}/mailboxes`;
  const canAdd = options !== null && options.domains.length > 0 && options.remaining > 0;
  const creating = canAdd && param(sp, "new") === "1" ? options : null;

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Each mailbox is an address with its own storage. Aliases point more addresses at it."
        breadcrumbs={crumbs}
      />
      {options?.domains.length === 0 && (
        <p className="am-body rounded-lg border px-4 py-3">
          Mailboxes live on your own domain.{" "}
          <Link
            href={`/accounts/${accountId}/domains?new=1`}
            className="text-primary underline-offset-2 hover:underline"
          >
            Add and verify a domain
          </Link>{" "}
          first.
        </p>
      )}
      {options && options.domains.length > 0 && options.remaining <= 0 && (
        <p className="am-small">This account has the most mailboxes it can have.</p>
      )}
      <MailboxList
        accountId={accountId}
        rows={mailboxes.map((m) => ({
          id: m.id,
          address: m.address,
          ownerEmail: m.owner?.email ?? null,
          quotaGb: m.quotaBytes / GB,
          status: m.status,
          applyFailed: m.applyFailed,
          restorableUntil: m.status === "deleting" && m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : null,
        }))}
        canManage={canManage}
        openId={open?.id ?? null}
        createHref={canAdd ? `${path}?new=1` : null}
        docsHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/mailboxes`}
        graceDays={MAILBOX_DELETE_GRACE_DAYS}
      />

      {open && (
        <UrlFlyout label={open.address} closeHref={path}>
          <MailboxPanel
            m={open}
            accountId={accountId}
            canManage={canManage}
            peopleHref={
              open.owner && can(actor, "member.read", accountId)
                ? `/accounts/${accountId}/people?person=${encodeURIComponent(open.owner.userId)}`
                : null
            }
            graceDays={MAILBOX_DELETE_GRACE_DAYS}
            tab={param(sp, "tab")}
          />
        </UrlFlyout>
      )}
      {creating && (
        <UrlFlyout label="Add a mailbox" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Add a mailbox</h2>
              <p className="am-small">An address on one of your domains, with its own storage and password.</p>
            </div>
            <CreateMailboxForm accountId={accountId} options={creating} />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
