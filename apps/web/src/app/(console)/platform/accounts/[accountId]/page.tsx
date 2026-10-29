// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { can, NotFoundError } from "@anhourmail/core";
import { accountAvatars, avatarPath } from "@anhourmail/core/avatars";
import { GB } from "@anhourmail/core/mailboxes";
import { staffSuspensionView, viewAccount } from "@anhourmail/core/platform";
import { PLANS } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { requestIdFrom } from "@anhourmail/server/request-context";
import { PageHeader } from "@anhourmail/ui/page-header";

import { Avatar } from "@/components/account-menu";
import { ListEmpty } from "@/components/console/data-list";
import { listClass } from "@/components/console/list-classes";
import { DetailTabs, Field, FieldGrid } from "@/components/console/flyout";
import { StatusText, type Tone } from "@/components/console/status-text";
import { CopyValue } from "@/components/copy-value";
import { MailboxStatus } from "@/components/mailboxes/mailbox-status";
import { StaffCreateAddress } from "@/components/platform/staff-create-address";
import { SuspensionControl } from "@/components/platform/suspension-control";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { platform } from "@/server/platform";
import { clientIp } from "@anhourmail/server/client-ip";

export const metadata: Metadata = { title: "Customer account" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
const DOMAIN_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending_dns: { text: "Waiting for DNS", tone: "info" },
  active: { text: "Active", tone: "success" },
  removing: { text: "Removing", tone: "warning" },
};

export default async function CustomerAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  if (!can(actor, "platform.accounts.read")) notFound();
  const h = await headers();
  let detail;
  try {
    // Opening the page is recorded in the account's own audit log (rule 49).
    detail = await viewAccount(container().deps, actor, accountId, {
      requestId: requestIdFrom(h),
      ip: clientIp(h),
      userAgent: h.get("user-agent"),
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { summary, people, domains, mailboxes, pendingInvites } = detail;
  const suspension = await staffSuspensionView(container().deps, actor, accountId);
  const photos = await accountAvatars(container().deps, actor, accountId);
  const photoOf = (userId: string) => {
    const version = photos.people[userId];
    return version ? avatarPath("/api/avatars", { kind: "person", id: userId, version }) : null;
  };
  // Suspending and lifting: Global Administrator only, never while acting as someone (the server checks again).
  const canSuspend = can(actor, "platform.account.suspend") && actor.actingAs === undefined;

  const peopleTab = (
    <>
      {pendingInvites > 0 && (
        <p className="am-small am-num mb-3">
          {pendingInvites === 1 ? "1 pending invite" : `${String(pendingInvites)} pending invites`}
        </p>
      )}
      {people.length === 0 ? (
        <ListEmpty>Nobody.</ListEmpty>
      ) : (
        <div className={listClass.wrap}>
          <table className={listClass.table}>
            <thead>
              <tr>
                <th scope="col" className={listClass.th}>
                  Person
                </th>
                <th scope="col" className={listClass.th}>
                  Role
                </th>
                <th scope="col" className={`${listClass.th} hidden sm:table-cell`}>
                  Status
                </th>
                <th scope="col" className={`${listClass.th} hidden md:table-cell`}>
                  Joined
                </th>
                {canSuspend && (
                  <th scope="col" className={listClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className={listClass.row}>
                  <td className={listClass.td}>
                    <div className="flex items-center gap-3">
                      <Avatar name={p.name} email={p.email} photoUrl={photoOf(p.userId)} size="sm" />
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium text-[14px]">{p.name}</span>
                        <span className="font-mono text-[12.5px] break-all text-muted-foreground">{p.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className={listClass.td}>{ROLE_LABELS[`account:${p.role}`]}</td>
                  <td className={`${listClass.td} hidden sm:table-cell`}>
                    <StatusText tone={p.suspended ? "neutral" : "success"}>
                      {p.suspended ? "Suspended" : "Active"}
                    </StatusText>
                  </td>
                  <td className={`${listClass.td} am-num hidden md:table-cell`}>{dateFmt.format(p.joinedAt)}</td>
                  {canSuspend && (
                    <td className={listClass.td}>
                      {p.userId !== actor.userId && (
                        <SuspensionControl
                          kind="person"
                          url={`/api/platform/people/${encodeURIComponent(p.userId)}/suspension`}
                          suspended={p.suspended}
                          subject={p.email}
                        />
                      )}
                      {suspension.people[p.userId] && (
                        <p className="am-micro mt-1">
                          {suspension.people[p.userId]?.reasonLabel}
                          {suspension.people[p.userId]?.note ? ` · ${suspension.people[p.userId]?.note ?? ""}` : ""}
                        </p>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  const domainsTab =
    domains.length === 0 ? (
      <ListEmpty>No custom domains.</ListEmpty>
    ) : (
      <ul className="border-t">
        {domains.map((d) => {
          const st = DOMAIN_STATUS[d.status] ?? { text: d.status, tone: "neutral" as const };
          return (
            <li
              key={d.id}
              className="flex min-h-[46px] flex-wrap items-center justify-between gap-2 border-b px-1 py-2"
            >
              <code className="font-mono font-medium text-[14px] break-all">{d.name}</code>
              <StatusText tone={st.tone}>{st.text}</StatusText>
            </li>
          );
        })}
      </ul>
    );

  // Staff create a free platform address here (Global Administrator; never while acting as someone).
  const staffCreate =
    can(actor, "platform.mailbox.create") && actor.actingAs === undefined ? (
      <StaffCreateAddress
        accountId={summary.id}
        domain={platform().freeAddressDomain}
        people={people.map((p) => ({ userId: p.userId, email: p.email }))}
      />
    ) : null;

  const mailboxList =
    mailboxes.length === 0 ? (
      <ListEmpty>No mailboxes.</ListEmpty>
    ) : (
      <div className={listClass.wrap}>
        <table className={listClass.table}>
          <thead>
            <tr>
              <th scope="col" className={listClass.th}>
                Address
              </th>
              <th scope="col" className={`${listClass.th} hidden sm:table-cell`}>
                Storage
              </th>
              <th scope="col" className={listClass.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((m) => (
              <tr key={m.id} className={listClass.row}>
                <td className={`${listClass.td} font-mono font-medium text-[14px] break-all`}>{m.address}</td>
                <td className={`${listClass.td} am-num hidden sm:table-cell`}>{m.quotaBytes / GB} GB</td>
                <td className={listClass.td}>
                  <MailboxStatus status={m.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHeader
        title={summary.name}
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Customer accounts", href: "/platform/accounts" },
          { label: summary.name },
        ]}
      />
      <p className="am-small max-w-prose rounded-lg border px-4 py-3">
        Opening this page is recorded in the account&apos;s audit log, where its admins see it as Anhourtec staff.
      </p>
      {canSuspend && (
        <div className="flex flex-wrap items-start gap-3">
          <SuspensionControl
            kind="account"
            url={`/api/platform/accounts/${encodeURIComponent(summary.id)}/suspension`}
            suspended={suspension.account !== null}
            subject={summary.name}
          />
        </div>
      )}
      <FieldGrid>
        <Field label="Plan">{PLANS[summary.plan].name}</Field>
        <Field label="Status">
          <StatusText tone={summary.status === "active" ? "success" : "danger"}>
            {summary.status === "active" ? "Active" : summary.status === "suspended" ? "Suspended" : summary.status}
          </StatusText>
        </Field>
        {suspension.account && (
          <Field label="Suspension">
            <span className="flex flex-col gap-0.5">
              <span>
                {suspension.account.reasonLabel} · since{" "}
                <span className="am-num">{dateFmt.format(suspension.account.at)}</span>
              </span>
              {suspension.account.note && (
                <span className="am-small break-words">Internal note: {suspension.account.note}</span>
              )}
            </span>
          </Field>
        )}
        <Field label="Created">
          <span className="am-num">{dateFmt.format(summary.createdAt)}</span>
        </Field>
        <Field label="Account id">
          <CopyValue value={summary.id} label="account id" />
        </Field>
      </FieldGrid>
      <DetailTabs
        label="Account details"
        tabs={[
          { id: "people", label: `People (${String(people.length)})`, content: peopleTab },
          { id: "domains", label: `Domains (${String(domains.length)})`, content: domainsTab },
          {
            id: "mailboxes",
            label: `Mailboxes (${String(mailboxes.length)})`,
            content: (
              <>
                {staffCreate}
                {mailboxList}
              </>
            ),
          },
        ]}
      />
    </>
  );
}
