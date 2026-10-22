// SPDX-License-Identifier: AGPL-3.0-only
/** Plain descriptions of the account roles (roles.md), for the People page and the person panel. */
export const ROLE_HELP: [string, string][] = [
  ["Owner", "Everything, including other owners and admins. An account always has at least one."],
  ["Domain Administrator", "Domains and DNS."],
  ["User Administrator", "Mailboxes, everyone's aliases, and inviting or removing Members."],
  ["Billing Administrator", "The plan and invoices."],
  ["Member", "Their own mailbox and aliases."],
  ["Read-only (Auditor)", "Sees settings, people, domains and the audit log; changes nothing."],
];

export function RoleHelp({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {items.map(([role, text]) => (
        <div key={role} className="contents">
          <dt className="text-[14px] font-medium">{role}</dt>
          <dd className="am-small">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
