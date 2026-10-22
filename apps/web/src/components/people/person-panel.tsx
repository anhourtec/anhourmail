// SPDX-License-Identifier: AGPL-3.0-only
import type { MemberView } from "@anhourmail/core/people";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";
import { ShieldCheck } from "lucide-react";

import { ActionLink, DetailHeader, DetailTabs, Field, FieldGrid, PanelSection, TabLink } from "../console/flyout";
import { initialsOf } from "../console/initials";
import { StatusText } from "../console/status-text";
import { CopyValue } from "../copy-value";
import { RemovePerson, RoleForm } from "./person-actions";
import { ROLE_HELP, RoleHelp } from "./role-help";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * A person's details panel: header (initials, name, status and role, inline actions), then Account (fields, their
 * mailboxes) and Role (Owners only). What's offered follows the service's answer for this viewer.
 */
export function PersonPanel({
  accountId,
  person,
  mailboxes,
  mailboxesHref,
  closeHref,
  tab,
}: {
  accountId: string;
  person: MemberView;
  /** Their mailboxes, when the viewer can see mailboxes (null otherwise). */
  mailboxes: { id: string; address: string }[] | null;
  mailboxesHref: string;
  closeHref: string;
  tab?: string | null;
}) {
  const roleLabel = ROLE_LABELS[`account:${person.role}`];
  const name = person.name || person.email;
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
        </FieldGrid>
      ),
    },
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
              <RemovePerson accountId={accountId} userId={person.userId} label={person.email} closeHref={closeHref} />
            )}
          </>
        }
      />
      <DetailTabs key={person.userId} tabs={tabs} initial={tab ?? null} />
    </div>
  );
}
