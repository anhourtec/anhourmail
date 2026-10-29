// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxAppPasswords } from "@anhourmail/core/app-passwords";
import { GB, type MailboxView } from "@anhourmail/core/mailboxes";
import { formatBytes, type StoragePool, storageSummary } from "@anhourmail/shared/storage";
import { HardDrive, KeyRound, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";

import { AppPasswordList } from "../app-passwords/app-password-list";
import { CopyValue } from "../copy-value";
import { ActionLink, DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { ProfilePhoto } from "../people/profile-photo";
import { EditMailboxName } from "./edit-mailbox-name";
import { DeleteMailbox, RestoreMailbox, SuspendMailbox } from "./mailbox-lifecycle";
import { MailboxStatus } from "./mailbox-status";
import { QuotaForm } from "./quota-form";
import { ResetMailboxPassword } from "./reset-mailbox-password";
import { StorageLevelText, UsageBar, UsedOfQuota } from "./storage-usage";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

/** A label / value row with a hairline under it (the Storage tab's lined layout). */
function StorageRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-3.5 text-[14px] sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-6">
      <dt className="font-medium">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

type Detail = MailboxView & {
  maxQuotaBytes: number;
  minQuotaBytes: number;
  pool: StoragePool;
  lifecycleLocked: boolean;
  passwordPending: boolean;
  passwordApplyFailed: boolean;
  canSetPassword: boolean;
};

/**
 * The mailbox details panel: header (photo or initials, address, status, inline actions) and tabs — Overview (label / value
 * / manage grid), Storage (used and quota as lined rows; the quota form for people who manage mailboxes) and Access for
 * people who manage mailboxes. What's offered follows the same rules the
 * server enforces (an admin's or owner's mailbox needs an owner to suspend, delete or restore).
 */
export function MailboxPanel({
  m,
  accountId,
  canManage,
  peopleHref,
  makeUserHref = null,
  graceDays,
  appPasswords,
  storageCheckedAgo,
  photoUrl = null,
  tab,
}: {
  m: Detail;
  accountId: string;
  canManage: boolean;
  /** Link to the owner's person panel, when the viewer can see people. */
  peopleHref: string | null;
  /** "Make this a user" for a person-less mailbox, when this admin may add users now. */
  makeUserHref?: string | null;
  graceDays: number;
  /** Its app passwords (names and dates only), for people who can see mailboxes. */
  appPasswords: MailboxAppPasswords | null;
  /** "Updated 5 minutes ago" for the last storage measurement, or null if it was never measured. */
  storageCheckedAgo: string | null;
  /** The photo shown for it (its person's, or its own when it has none), on this origin; null for initials. */
  photoUrl?: string | null;
  tab?: string | null;
}) {
  const deleting = m.status === "deleting";
  const lifecycle = canManage && !m.lifecycleLocked;
  const purgeOn = m.purgeAfter ? dateFmt.format(new Date(m.purgeAfter)) : null;
  const quotaGb = m.quotaBytes / GB;
  const usage = storageSummary(m.storageUsedBytes, m.quotaBytes);
  /** The account's mailboxes were kept above its pool when storage became pooled, so the mail already in them fits. */
  const abovePool = m.pool.assignedBytes > m.pool.poolBytes;
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
            <Field label="Display name">
              <EditMailboxName
                accountId={accountId}
                mailboxId={m.id}
                name={m.displayName}
                canEdit={canManage && !deleting && !m.lifecycleLocked}
              />
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
                ) : !m.owner && makeUserHref ? (
                  <ActionLink href={makeUserHref} plain>
                    Make this a user
                  </ActionLink>
                ) : undefined
              }
            >
              {m.owner ? <span className="break-all">{m.owner.email}</span> : "Nobody yet"}
            </Field>
            <Field label="Photo">
              {m.owner ? (
                <span className="text-muted-foreground">Their own profile photo, if they have one</span>
              ) : canManage && !deleting ? (
                <ProfilePhoto
                  url={photoUrl}
                  initials={initialsOf(m.address)}
                  endpoint={`/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(m.id)}/avatar`}
                  subject={`the photo of ${m.address}`}
                />
              ) : photoUrl ? (
                "Set"
              ) : (
                "None"
              )}
            </Field>
            <Field
              label="Storage"
              manage={
                <TabLink tab="storage" plain>
                  {canManage && !deleting ? "Change storage" : "View storage"}
                </TabLink>
              }
            >
              <UsedOfQuota usedBytes={m.storageUsedBytes} quotaBytes={m.quotaBytes} />
              {usage.percent && <span className="am-num text-muted-foreground"> · {usage.percent}</span>}
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
    {
      id: "storage",
      label: "Storage",
      content: (
        <div className="flex flex-col gap-8">
          <dl className="flex flex-col border-t">
            <StorageRow label="Used">
              <div className="flex w-full max-w-sm flex-col gap-1.5">
                {usage.used === null ? (
                  <span>Not measured yet. Storage is measured every few minutes.</span>
                ) : (
                  <>
                    <UsageBar fraction={usage.fraction} level={usage.level} className="mt-1.5" />
                    <span>
                      <UsedOfQuota usedBytes={m.storageUsedBytes} quotaBytes={m.quotaBytes} />
                      <span className="am-num text-muted-foreground"> · {usage.percent}</span>
                    </span>
                    <StorageLevelText level={usage.level} label={usage.label} />
                  </>
                )}
                {storageCheckedAgo && <span className="am-micro">{storageCheckedAgo}</span>}
              </div>
            </StorageRow>
            <StorageRow label="Share">
              <span>
                <span className="am-num">{formatBytes(m.quotaBytes)}</span> of the account&apos;s{" "}
                <span className="am-num">{formatBytes(m.pool.poolBytes)}</span>, shared by all its mailboxes
              </span>
            </StorageRow>
            <StorageRow label="Unassigned">
              {abovePool ? (
                <span>
                  None. The account&apos;s mailboxes are given{" "}
                  <span className="am-num">{formatBytes(m.pool.assignedBytes)}</span>, above its storage, so the mail
                  already in them fits
                </span>
              ) : (
                <span>
                  <span className="am-num">{formatBytes(m.pool.unassignedBytes)}</span> not given to any mailbox
                </span>
              )}
            </StorageRow>
          </dl>
          {canManage && !deleting && (
            <section aria-label="Change storage" className="flex flex-col gap-3">
              <h3 className="am-h4">Change storage</h3>
              <QuotaForm
                accountId={accountId}
                mailboxId={m.id}
                currentGb={quotaGb}
                minGb={Math.min(quotaGb, m.minQuotaBytes / GB)}
                maxGb={Math.max(quotaGb, m.maxQuotaBytes / GB)}
              />
            </section>
          )}
        </div>
      ),
    },
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
                applyFailed={m.passwordApplyFailed}
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
        photoUrl={photoUrl}
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
