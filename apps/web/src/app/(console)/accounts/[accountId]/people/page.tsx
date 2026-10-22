// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can } from "@anhourmail/core";
import { listPeople } from "@anhourmail/core/people";
import { INVITE_TTL_DAYS } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { PageHeader } from "@anhourmail/ui/page-header";

import { InviteForm } from "@/components/people/invite-form";
import { InviteActions, MemberActions } from "@/components/people/row-actions";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "People and roles" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

const ROLE_HELP: [string, string][] = [
  ["Owner", "Everything, including other owners and admins. An account always has at least one."],
  ["Domain Administrator", "Domains and DNS."],
  ["User Administrator", "Mailboxes, everyone's aliases, and inviting or removing Members."],
  ["Billing Administrator", "The plan and invoices."],
  ["Member", "Their own mailbox and aliases."],
  ["Read-only (Auditor)", "Sees settings, people, domains and the audit log; changes nothing."],
];

const th = "am-mono px-4 py-2.5 font-normal";

export default async function PeoplePage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => listPeople(container().deps, actor, accountId));
  const crumbs = [{ label: "Overview", href: "/" }, { label: "People and roles" }];
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
  const { members, invites, grantableRoles, limits } = data;
  const canInvite = can(actor, "member.manage", accountId);

  return (
    <>
      <PageHeader
        title="People and roles"
        description="Who can manage this account in the console, and what each of them can do. Mailboxes are separate: removing someone keeps their mail."
        breadcrumbs={crumbs}
      />
      {limits.addPeople && (
        <p className="am-small am-num">
          {limits.used} of {limits.max} people, counting pending invites
        </p>
      )}

      {canInvite &&
        (!limits.addPeople ? (
          <p className="am-body rounded-xl border px-4 py-3">
            The {limits.planName} plan is for one person. Upgrade to Plus to invite family or a small group.
          </p>
        ) : limits.used >= limits.max ? (
          <p className="am-small">
            This account has as many people as it can have. Revoke an invite or remove someone first.
          </p>
        ) : (
          <InviteForm accountId={accountId} roles={grantableRoles} inviteDays={INVITE_TTL_DAYS} />
        ))}

      <section aria-labelledby="people" className="flex flex-col gap-3">
        <h2 id="people" className="am-h3">
          People
        </h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left">
            <thead className="border-b bg-muted/50">
              <tr>
                <th scope="col" className={th}>
                  Person
                </th>
                <th scope="col" className={th}>
                  Role
                </th>
                <th scope="col" className={`${th} hidden sm:table-cell`}>
                  Status
                </th>
                <th scope="col" className={`${th} hidden lg:table-cell`}>
                  Joined
                </th>
                <th scope="col" className={`${th} text-right`}>
                  <span className="sr-only">Change role or remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="am-body flex flex-wrap items-center gap-2">
                        {m.name}
                        {m.isYou && <span className="am-status am-status--info">You</span>}
                      </span>
                      <span className="am-code break-all text-muted-foreground">{m.email}</span>
                    </div>
                  </td>
                  <td className="am-small px-4 py-3">{ROLE_LABELS[`account:${m.role}`]}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <span className={`am-status am-status--${m.status === "active" ? "success" : "neutral"}`}>
                      {m.status === "active" ? "Active" : "Suspended"}
                    </span>
                  </td>
                  <td className="am-small am-num hidden px-4 py-3 lg:table-cell">{dateFmt.format(m.joinedAt)}</td>
                  <td className="px-4 py-3">
                    {(m.canChangeRole || m.canRemove) && (
                      <MemberActions
                        accountId={accountId}
                        userId={m.userId}
                        label={m.email}
                        role={m.role}
                        canChangeRole={m.canChangeRole}
                        canRemove={m.canRemove}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="invites" className="flex flex-col gap-3">
        <h2 id="invites" className="am-h3">
          Pending invites
        </h2>
        {invites.length === 0 ? (
          <p className="am-small">No pending invites.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th scope="col" className={th}>
                    Email
                  </th>
                  <th scope="col" className={`${th} hidden sm:table-cell`}>
                    Role
                  </th>
                  <th scope="col" className={`${th} hidden md:table-cell`}>
                    Link works until
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Resend or revoke</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invites.map((i) => (
                  <tr key={i.id} className={i.expired ? "text-muted-foreground" : ""}>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="am-code break-all">{i.email}</span>
                        <span className="flex flex-wrap gap-1.5">
                          <span className={`am-status am-status--${i.expired ? "warning" : "info"}`}>
                            {i.expired ? "Expired" : "Pending"}
                          </span>
                          <span className="am-micro sm:hidden">{ROLE_LABELS[`account:${i.role}`]}</span>
                        </span>
                      </div>
                    </td>
                    <td className="am-small hidden px-4 py-3 sm:table-cell">{ROLE_LABELS[`account:${i.role}`]}</td>
                    <td className="am-small am-num hidden px-4 py-3 md:table-cell">{dateFmt.format(i.expiresAt)}</td>
                    <td className="px-4 py-3">
                      {i.canManage && <InviteActions accountId={accountId} inviteId={i.id} email={i.email} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="rounded-xl border px-4 py-3">
        <summary className="am-h4 cursor-pointer">What each role can do</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
          {ROLE_HELP.map(([role, text]) => (
            <div key={role} className="contents">
              <dt className="am-small font-medium text-foreground">{role}</dt>
              <dd className="am-small">{text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
