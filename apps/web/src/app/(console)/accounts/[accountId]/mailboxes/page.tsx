// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { listMailboxAppPasswords } from "@anhourmail/core/app-passwords";
import { getMailbox, listMailboxes, mailboxOptions, mailboxStoragePool } from "@anhourmail/core/mailboxes";
import { grantableRoles } from "@anhourmail/core/people";
import { MAILBOX_DELETE_GRACE_DAYS, MAX_MAILBOXES } from "@anhourmail/shared/plans";
import { storageCheckedAgo } from "@anhourmail/shared/storage";
import { PageHeader } from "@anhourmail/ui/page-header";

import { UrlFlyout } from "@/components/console/flyout";
import { ClaimPlatformAddress } from "@/components/mailboxes/claim-platform-address";
import { CreateMailboxForm } from "@/components/mailboxes/create-mailbox-form";
import { MailboxList } from "@/components/mailboxes/mailbox-list";
import { MailboxPanel } from "@/components/mailboxes/mailbox-panel";
import { StoragePoolSummary } from "@/components/mailboxes/storage-usage";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "Mailboxes" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

/**
 * Mailboxes (console page template). "Add a user" is its own page (`/mailboxes/new`). The details panel
 * (`?mailbox=<id>`, optional `&tab=`) and the "Add a shared address" panel (`?new=1`, opened from the ⋯ menu: an
 * address that isn't one person's sign-in, like support@) live in the URL so they can be linked, reloaded and closed
 * with Back. The old
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
    pool: await mailboxStoragePool(deps, actor, accountId),
    options: canManage ? await mailboxOptions(deps, actor, accountId) : null,
    open: openId ? await getMailbox(deps, actor, accountId, openId) : null,
    appPasswords: openId ? await listMailboxAppPasswords(deps, actor, accountId, openId) : null,
    // When the page was read, for "Updated 5 minutes ago" (storage is measured every ~10 minutes).
    now: new Date(),
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
  const { mailboxes, pool, options, open, appPasswords } = data;
  const path = `/accounts/${accountId}/mailboxes`;
  const canAdd = options !== null && options.remaining > 0 && (options.domains.length > 0 || options.platform.allowed);
  const creating = canAdd && param(sp, "new") === "1" ? options : null;
  // The free platform address (ADR-0021): offered until the account has one, while the plan has room.
  const canClaim = options !== null && options.platform.used === 0 && options.platform.allowed;
  const claiming = canClaim && param(sp, "claim") === "1" ? options : null;

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Each mailbox is an address with its share of the account's storage. Users you add here get their own mailbox and console sign-in, and appear in People and roles."
        breadcrumbs={crumbs}
      />
      <StoragePoolSummary pool={pool} />
      {canClaim && (
        <div className="flex flex-col gap-2 rounded-lg border border-l-4 border-l-primary bg-card px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="am-h4">Get your free @{options.platform.domain} address</h2>
            <p className="am-small">
              Pick a name and a password, and it&apos;s yours to use in the webmail and mail apps.
            </p>
          </div>
          <Link
            href={`${path}?claim=1`}
            className="w-fit shrink-0 text-[14px] text-primary underline-offset-2 hover:underline"
          >
            Choose your address
          </Link>
        </div>
      )}
      {options?.domains.length === 0 && !options.platform.allowed && options.remaining > 0 && (
        <p className="am-body rounded-lg border px-4 py-3">
          {options.customDomains ? (
            <>
              More mailboxes live on your own domain.{" "}
              <Link
                href={`/accounts/${accountId}/domains?new=1`}
                className="text-primary underline-offset-2 hover:underline"
              >
                Add and verify a domain
              </Link>{" "}
              first.
            </>
          ) : (
            "More mailboxes come with your own domain, on the Plus and Supporter plans."
          )}
        </p>
      )}
      {options && options.remaining <= 0 && (
        <p className="am-small">
          This account has all <span className="am-num">{MAX_MAILBOXES}</span> mailboxes its plan includes. More
          mailboxes come with billing, which isn&apos;t open yet.
        </p>
      )}
      <MailboxList
        accountId={accountId}
        rows={mailboxes.map((m) => ({
          id: m.id,
          address: m.address,
          ownerEmail: m.owner?.email ?? null,
          quotaBytes: m.quotaBytes,
          usedBytes: m.storageUsedBytes,
          status: m.status,
          applyFailed: m.applyFailed,
          restorableUntil: m.status === "deleting" && m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : null,
        }))}
        canManage={canManage}
        openId={open?.id ?? null}
        createHref={canAdd ? `${path}?new=1` : null}
        addUserHref={canAdd && grantableRoles(actor, accountId).length > 0 ? `${path}/new` : null}
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
            makeUserHref={
              canManage && !open.owner && open.status === "active" && grantableRoles(actor, accountId).length > 0
                ? `${path}/${open.id}/make-user`
                : null
            }
            graceDays={MAILBOX_DELETE_GRACE_DAYS}
            appPasswords={appPasswords}
            storageCheckedAgo={storageCheckedAgo(open.storageCheckedAt, data.now)}
            tab={param(sp, "tab")}
          />
        </UrlFlyout>
      )}
      {claiming && (
        <UrlFlyout label={`Get your free @${claiming.platform.domain} address`} closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Get your free @{claiming.platform.domain} address</h2>
              <p className="am-small">
                Names are first come, first served, and a name that was used before isn&apos;t given out again.
              </p>
            </div>
            <ClaimPlatformAddress
              accountId={accountId}
              domain={claiming.platform.domain}
              ownerUserId={actor.userId}
              emailVerified={claiming.platform.emailVerified}
              email={actor.email}
              webmailUrl={env().WEBMAIL_URL}
            />
          </div>
        </UrlFlyout>
      )}
      {creating && (
        <UrlFlyout label="Add a shared address" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Add a shared address</h2>
              <p className="am-small">
                An address that isn&apos;t one person&apos;s sign-in, like support@ or info@, on one of your domains
                {creating.platform.allowed ? (
                  <>
                    {" "}
                    or at <span className="am-code">{creating.platform.domain}</span>
                  </>
                ) : null}
                , with its own storage and password. To add a person with their own sign-in, use Add a user instead.
              </p>
            </div>
            <CreateMailboxForm accountId={accountId} options={creating} />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
