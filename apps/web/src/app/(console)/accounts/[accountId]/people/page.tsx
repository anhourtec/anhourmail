// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { listMailboxes } from "@anhourmail/core/mailboxes";
import { listPeople } from "@anhourmail/core/people";
import { INVITE_TTL_DAYS } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { PageHeader } from "@anhourmail/ui/page-header";

import { UrlFlyout } from "@/components/console/flyout";
import { InviteForm } from "@/components/people/invite-form";
import { PeopleList } from "@/components/people/people-list";
import { PersonPanel } from "@/components/people/person-panel";
import { ROLE_HELP, RoleHelp } from "@/components/people/role-help";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "People and roles" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * People and roles (console page template). `?person=<userId>` opens a person's panel (`&tab=role` for the role),
 * `?new=1` the "Invite someone" panel. Ids that aren't a member of this account are a 404.
 */
export default async function PeoplePage({
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
  const openId = param(sp, "person");
  const data = await forPage(async () => ({
    overview: await listPeople(deps, actor, accountId),
    mailboxes: openId && can(actor, "mailbox.read", accountId) ? await listMailboxes(deps, actor, accountId) : null,
  }));
  const crumbs = [{ label: "Home", href: "/" }, { label: "People and roles" }];
  if (!data) {
    return (
      <>
        <PageHeader title="People and roles" breadcrumbs={crumbs} />
        <p className="am-body">
          Your role in this account doesn't include its people. Ask an owner if you need access.
        </p>
      </>
    );
  }
  const { members, invites, grantableRoles, limits } = data.overview;
  const open = openId ? members.find((m) => m.userId === openId) : undefined;
  if (openId && !open) notFound();
  const canInvite = can(actor, "member.manage", accountId);
  const room = limits.addPeople && limits.used < limits.max;
  const path = `/accounts/${accountId}/people`;

  return (
    <>
      <PageHeader
        title="People and roles"
        description="Who can sign in to this account in the console, and what each of them can do. Users added on the Mailboxes page appear here too. Removing someone keeps their mail."
        breadcrumbs={crumbs}
      />
      {limits.addPeople && (
        <p className="am-small am-num -mt-2">
          {limits.used} of {limits.max} people, counting pending invites
        </p>
      )}
      {canInvite && !limits.addPeople && (
        <p className="am-body rounded-lg border px-4 py-3">
          The {limits.planName} plan is for one person. Upgrade to Plus to invite family or a small group.
        </p>
      )}
      {canInvite && limits.addPeople && !room && (
        <p className="am-small">
          This account has as many people as it can have. Revoke an invite or remove someone first.
        </p>
      )}

      <PeopleList
        accountId={accountId}
        people={members.map((m) => ({
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
          roleLabel: ROLE_LABELS[`account:${m.role}`],
          active: m.status === "active",
          isYou: m.isYou,
          joined: dateFmt.format(m.joinedAt),
          joinedAt: m.joinedAt.getTime(),
          canChangeRole: m.canChangeRole,
          canRemove: m.canRemove,
        }))}
        invites={invites.map((i) => ({
          id: i.id,
          email: i.email,
          roleLabel: ROLE_LABELS[`account:${i.role}`],
          expired: i.expired,
          until: dateFmt.format(i.expiresAt),
          canManage: i.canManage,
        }))}
        openId={open?.userId ?? null}
        inviteHref={canInvite && room ? `${path}?new=1` : null}
        docsHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/people-and-roles`}
      />

      <details id="roles" className="mt-2 rounded-lg border px-4 py-3">
        <summary className="am-h4 cursor-pointer">What each role can do</summary>
        <div className="mt-3">
          <RoleHelp items={ROLE_HELP} />
        </div>
      </details>

      {open && (
        <UrlFlyout label={open.name || open.email} closeHref={path}>
          <PersonPanel
            accountId={accountId}
            person={open}
            mailboxes={
              data.mailboxes
                ?.filter((m) => m.owner?.userId === open.userId)
                .map((m) => ({ id: m.id, address: m.address })) ?? null
            }
            mailboxesHref={`/accounts/${accountId}/mailboxes`}
            closeHref={path}
            tab={param(sp, "tab")}
          />
        </UrlFlyout>
      )}
      {canInvite && room && param(sp, "new") === "1" && (
        <UrlFlyout label="Invite someone" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Invite someone</h2>
              <p className="am-small">
                We email them a link that works for {INVITE_TTL_DAYS} days. The link never appears here.
              </p>
            </div>
            <InviteForm accountId={accountId} roles={grantableRoles} inviteDays={INVITE_TTL_DAYS} />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
