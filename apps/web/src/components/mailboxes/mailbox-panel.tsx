// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxAppPasswords } from "@anhourmail/core/app-passwords";
import { GB, type MailboxView } from "@anhourmail/core/mailboxes";
import { HardDrive, KeyRound, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";

import { AppPasswordList } from "../app-passwords/app-password-list";
import { CopyValue } from "../copy-value";
import { ActionLink, DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { DeleteMailbox, RestoreMailbox, SuspendMailbox } from "./mailbox-lifecycle";
import { MailboxStatus } from "./mailbox-status";
import { QuotaForm } from "./quota-form";
import { ResetMailboxPassword } from "./reset-mailbox-password";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

type Detail = MailboxView & {
  maxQuotaBytes: number;
  lifecycleLocked: boolean;
  passwordPending: boolean;
  canSetPassword: boolean;
};

/**
 * The mailbox details panel: header (initials, address, status, inline actions) and tabs — Overview (label / value
 * / manage grid), Storage and Access for people who manage mailboxes. What's offered follows the same rules the
 * server enforces (an admin's or owner's mailbox needs an owner to suspend, delete or restore).
 */
export function MailboxPanel({
  m,
  accountId,
  canManage,
  peopleHref,
  graceDays,
  appPasswords,
  tab,
}: {
  m: Detail;
  accountId: string;
  canManage: boolean;
  /** Link to the owner's person panel, when the viewer can see people. */
  peopleHref: string | null;
  graceDays: number;
  /** Its app passwords (names and dates only), for people who can see mailboxes. */
  appPasswords: MailboxAppPasswords | null;
  tab?: string | null;
}) {
  const deleting = m.status === "deleting";
  const lifecycle = canManage && !m.lifecycleLocked;
  const purgeOn = m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : null;
  const quotaGb = m.quotaBytes / GB;
  /** Setting a password needs the mailbox on the mail server and not being deleted (the server says so too). */
  const passwordSettable = m.canSetPassword && (m.status === "active" || m.status === "suspended");

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: (
        <>
          <FieldGrid>
            <Field label="Address">
              <CopyValue value={m.address} label="address" />
            </Field>
            <Field
              label="Sign-in and delivery"
              manage={
                lifecycle ? (
                  <TabLink tab="access" plain>
                    Manage access
                  </TabLink>
                ) : undefined
              }
            >
              {m.status === "suspended"
                ? "Off: nobody can sign in and mail to it is refused"
                : deleting
                  ? `Off while it's being deleted${purgeOn ? ` (restorable until ${purgeOn})` : ""}`
                  : m.status === "active"
                    ? "On"
                    : "Not on the mail server yet"}
            </Field>
            <Field
              label="Belongs to"
              manage={
                m.owner && peopleHref ? (
                  <ActionLink href={peopleHref} plain>
                    View person
                  </ActionLink>
                ) : undefined
              }
            >
              {m.owner ? <span className="break-all">{m.owner.email}</span> : "Nobody yet"}
            </Field>
            <Field
              label="Storage"
              manage={
                canManage && !deleting ? (
                  <TabLink tab="storage" plain>
                    Change storage
                  </TabLink>
                ) : undefined
              }
            >
              <span className="am-num">{quotaGb} GB</span>
            </Field>
            {appPasswords && (
              <Field
                label="App passwords"
                manage={
                  <TabLink tab="app-passwords" plain>
                    View app passwords
                  </TabLink>
                }
              >
                <span className="am-num">{appPasswords.appPasswords.length}</span>
              </Field>
            )}
            <Field label="Created">
              <span className="am-num">{dateFmt.format(new Date(m.createdAt))}</span>
            </Field>
          </FieldGrid>
          {canManage && m.lifecycleLocked && (
            <p className="am-small mt-8 max-w-prose rounded-lg border px-4 py-3">
              This mailbox belongs to an owner or an admin, so only an owner can suspend, delete or restore it.
            </p>
          )}
        </>
      ),
    },
    ...(appPasswords
      ? [
          {
            id: "app-passwords",
            label: "App passwords",
            content: (
              <div className="flex flex-col gap-4">
                <p className="am-body max-w-prose">
                  Mail apps sign in to this mailbox with these. Only the person it belongs to can create them, on their
                  own App passwords page; nobody else ever sees a password.
                  {appPasswords.canCreate && (
                    <>
                      {" "}
                      <Link
                        href={`/accounts/${accountId}/app-passwords`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Create one on your App passwords page
                      </Link>
                      .
                    </>
                  )}
                </p>
                <AppPasswordList
                  accountId={accountId}
                  mailboxId={m.id}
                  address={m.address}
                  canRevoke={appPasswords.canRevoke}
                  rows={appPasswords.appPasswords.map((p) => ({
                    id: p.id,
                    name: p.name,
                    protocols: p.protocols,
                    revoking: p.status === "revoking",
                    created: dateFmt.format(new Date(p.createdAt)),
                  }))}
                />
              </div>
            ),
          },
        ]
      : []),
    ...(canManage && !deleting
      ? [
          {
            id: "storage",
            label: "Storage",
            content: (
              <div className="flex flex-col gap-3">
                <p className="am-body">
                  Now <span className="am-num">{quotaGb} GB</span>, up to{" "}
                  <span className="am-num">{m.maxQuotaBytes / GB} GB</span> on this plan.
                </p>
                <QuotaForm accountId={accountId} mailboxId={m.id} currentGb={quotaGb} maxGb={m.maxQuotaBytes / GB} />
              </div>
            ),
          },
        ]
      : []),
    ...(passwordSettable
      ? [
          {
            id: "password",
            label: "Password",
            content: (
              <ResetMailboxPassword
                accountId={accountId}
                mailboxId={m.id}
                address={m.address}
                ownerEmail={m.owner?.email ?? null}
                pending={m.passwordPending}
              />
            ),
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            id: "access",
            label: "Access",
            content: m.lifecycleLocked ? (
              <p className="am-small max-w-prose rounded-lg border px-4 py-3">
                This mailbox belongs to an owner or an admin, so only an owner can suspend, delete or restore it.
              </p>
            ) : deleting ? (
              <PanelSection title="Being deleted">
                <RestoreMailbox
                  accountId={accountId}
                  mailboxId={m.id}
                  purgeOn={purgeOn ?? "the end of its grace period"}
                  applyFailed={m.applyFailed}
                />
              </PanelSection>
            ) : (
              <>
                <PanelSection title="Sign-in and delivery">
                  <SuspendMailbox
                    accountId={accountId}
                    mailboxId={m.id}
                    suspended={m.status === "suspended"}
                    applyFailed={m.applyFailed}
                  />
                </PanelSection>
                <PanelSection title="Delete this mailbox">
                  <DeleteMailbox accountId={accountId} mailboxId={m.id} address={m.address} graceDays={graceDays} />
                </PanelSection>
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        initials={initialsOf(m.address)}
        name={m.address}
        mono
        status={
          <>
            <MailboxStatus status={m.status} applyFailed={m.applyFailed} />
            {deleting && purgeOn && <span className="am-micro am-num">Restorable until {purgeOn}</span>}
          </>
        }
        actions={
          <>
            {canManage && !deleting && (
              <TabLink tab="storage">
                <HardDrive aria-hidden />
                Change storage
              </TabLink>
            )}
            {passwordSettable && (
              <TabLink tab="password">
                <KeyRound aria-hidden />
                Set password
              </TabLink>
            )}
            {lifecycle && !deleting && (
              <TabLink tab="access">
                {m.status === "suspended" ? <Play aria-hidden /> : <Pause aria-hidden />}
                {m.status === "suspended" ? "Resume" : "Suspend"}
              </TabLink>
            )}
            {lifecycle && !deleting && (
              <TabLink tab="access">
                <Trash2 aria-hidden />
                Delete
              </TabLink>
            )}
            {lifecycle && deleting && (
              <TabLink tab="access">
                <RotateCcw aria-hidden />
                Restore
              </TabLink>
            )}
          </>
        }
      />
      <DetailTabs key={m.id} tabs={tabs} initial={tab ?? null} />
    </div>
  );
}
