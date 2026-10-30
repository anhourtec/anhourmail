// SPDX-License-Identifier: AGPL-3.0-only
import type { PersonDelegation } from "@anhourmail/core/delegation";
import type { MemberView, ProfileView } from "@anhourmail/core/people";
import { DELEGATION_RIGHT_LABELS } from "@anhourmail/shared/delegation";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";

import { ActionLink, DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { StatusText } from "../console/status-text";
import { CopyValue } from "../copy-value";
import { EditProfile } from "./edit-profile";
import { ProfilePhoto } from "./profile-photo";
import { RemovePerson, RoleForm } from "./person-actions";
import type { HandOver } from "./remove-person-dialog";
import { ROLE_HELP, RoleHelp } from "./role-help";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * A person's details panel: header (photo or initials, name, status and role, inline actions), then Account (fields,
 * their mailboxes, the mailboxes they can open or send from through delegation), Profile (their photo and the optional details, changeable by the person and the admins who may —
 * the same rule for both) and Role (Owners only). What's offered follows the service's answer for this viewer.
 */
export function PersonPanel({
  accountId,
  person,
  mailboxes,
  mailboxesHref,
  closeHref,
  profile = null,
  photoUrl = null,
  delegations = null,
  handOver = null,
  tab,
}: {
  accountId: string;
  person: MemberView;
  /** Their mailboxes, when the viewer can see mailboxes (null otherwise). */
  mailboxes: { id: string; address: string }[] | null;
  mailboxesHref: string;
  closeHref: string;
  /** Their optional profile details and whether this viewer may edit them. */
  profile?: ProfileView | null;
  /** Their profile photo on this origin (versioned), or null. */
  photoUrl?: string | null;
  /** "Mailboxes they can open": their delegated rights (`delegation.read`), or null when the viewer can't see them. */
  delegations?: PersonDelegation[] | null;
  /** What removing them offers for their mailboxes ("Give full access to …"). */
  handOver?: HandOver;
  tab?: string | null;
}) {
  const roleLabel = ROLE_LABELS[`account:${person.role}`];
  const name = person.name || person.email;
  const personUrl = `/api/accounts/${encodeURIComponent(accountId)}/people/${encodeURIComponent(person.userId)}`;
  const tabs = [
    {
      id: "account",
      label: "Account",
      content: (
        <FieldGrid>
          <Field label="Email (console sign-in)">
            <CopyValue value={person.email} label="email" />
          </Field>
          <Field
            label="Role"
            manage={
              person.canChangeRole ? (
                <TabLink tab="role" plain>
                  Change role
                </TabLink>
              ) : undefined
            }
          >
            {roleLabel}
          </Field>
          <Field label="Joined">
            <span className="am-num">{dateFmt.format(person.joinedAt)}</span>
          </Field>
          <Field label="Console access">{person.status === "active" ? "Can sign in" : "Suspended"}</Field>
          {mailboxes && (
            <Field
              label="Mailboxes"
              manage={
                <ActionLink href={mailboxesHref} plain>
                  Manage mailboxes
                </ActionLink>
              }
            >
              {mailboxes.length === 0 ? (
                "None"
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {mailboxes.map((m) => (
                    <li key={m.id} className="font-mono text-[13.5px] break-all">
                      {m.address}
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          )}
          {delegations && (
            <Field label="Mailboxes they can open">
              {delegations.length === 0 ? (
                "None given to them"
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {delegations.map((d) => (
                    <li key={d.mailboxId} className="flex flex-col">
                      {mailboxes ? (
                        <Link
                          href={`${mailboxesHref}?mailbox=${encodeURIComponent(d.mailboxId)}&tab=delegation`}
                          className="font-mono text-[13.5px] break-all text-primary underline-offset-2 hover:underline"
                        >
                          {d.address}
                        </Link>
                      ) : (
                        <span className="font-mono text-[13.5px] break-all">{d.address}</span>
                      )}
                      <span className="am-micro">{d.rights.map((r) => DELEGATION_RIGHT_LABELS[r]).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          )}
        </FieldGrid>
      ),
    },
    ...(profile
      ? [
          {
            id: "profile",
            label: "Profile",
            content: (
              <div className="flex flex-col gap-8">
                {profile.canEdit && (
                  <PanelSection title="Photo">
                    <ProfilePhoto
                      url={photoUrl}
                      initials={initialsOf(name)}
                      endpoint={`${personUrl}/avatar`}
                      subject={person.isYou ? "your photo" : `${name}'s photo`}
                    />
                  </PanelSection>
                )}
                <EditProfile
                  url={`${personUrl}/profile`}
                  details={profile.details}
                  canEdit={profile.canEdit}
                  readOnlyReason={profile.readOnlyReason}
                />
              </div>
            ),
          },
        ]
      : []),
    ...(person.canChangeRole
      ? [
          {
            id: "role",
            label: "Role",
            content: (
              <div className="flex flex-col gap-8">
                <RoleForm accountId={accountId} userId={person.userId} label={person.email} role={person.role} />
                <PanelSection title="What each role can do">
                  <RoleHelp items={ROLE_HELP} />
                </PanelSection>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        initials={initialsOf(name)}
        photoUrl={photoUrl}
        name={name}
        status={
          <>
            <StatusText tone={person.status === "active" ? "success" : "danger"}>
              {person.status === "active" ? "Active" : "Suspended"}
            </StatusText>
            <span className="text-[14px] text-muted-foreground">{roleLabel}</span>
            {person.isYou && <span className="am-status am-status--info">You</span>}
          </>
        }
        actions={
          <>
            {person.canChangeRole && (
              <TabLink tab="role">
                <ShieldCheck aria-hidden />
                Change role
              </TabLink>
            )}
            {person.canRemove && (
              <RemovePerson
                accountId={accountId}
                userId={person.userId}
                label={person.email}
                closeHref={closeHref}
                mailboxes={mailboxes?.map((m) => m.address) ?? null}
                handOver={handOver}
              />
            )}
          </>
        }
      />
      <DetailTabs key={person.userId} tabs={tabs} initial={tab ?? null} />
    </div>
  );
}
