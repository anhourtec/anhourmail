// SPDX-License-Identifier: AGPL-3.0-only
import { GB, type MailboxView } from "@anhourmail/core/mailboxes";
import { HardDrive, Pause, Play, RotateCcw, Trash2 } from "lucide-react";

import { CopyValue } from "../copy-value";
import { ActionLink, DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { DeleteMailbox, RestoreMailbox, SuspendMailbox } from "./mailbox-lifecycle";
import { MailboxStatus } from "./mailbox-status";
import { QuotaForm } from "./quota-form";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

type Detail = MailboxView & { maxQuotaBytes: number; lifecycleLocked: boolean };

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
  tab,
}: {
  m: Detail;
  accountId: string;
  canManage: boolean;
  /** Link to the owner's person panel, when the viewer can see people. */
  peopleHref: string | null;
  graceDays: number;
  tab?: string | null;
}) {
  const deleting = m.status === "deleting";
  const lifecycle = canManage && !m.lifecycleLocked;
  const purgeOn = m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : null;
  const quotaGb = m.quotaBytes / GB;

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
