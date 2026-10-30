// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { getMailboxDelegation } from "@anhourmail/core/delegation";
import { getMailbox } from "@anhourmail/core/mailboxes";
import { DELEGATION_RIGHTS, type DelegationRight } from "@anhourmail/shared/delegation";
import { grantableRoles, listPeople } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddUserWizard } from "@/components/mailboxes/add-user-wizard";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Make this a user" };

/**
 * "Make this a user" for a person-less mailbox (a shared mailbox): the "Add a user" steps without the address and
 * storage (Basics, Role, Optional settings, Review), ending in `makeMailboxUser`. Needs `mailbox.manage`, a role this
 * admin may grant and a plan with room for another person; the server checks all of it again. The review lists the
 * people who already have access to the mailbox through delegation (`delegation.read`), who keep it.
 */
export default async function MakeUserPage({ params }: { params: Promise<{ accountId: string; mailboxId: string }> }) {
  const { accountId, mailboxId } = await params;
  const actor = await requireUser();
  const deps = container().deps;
  const mailboxes = `/accounts/${accountId}/mailboxes`;
  const back = `${mailboxes}?mailbox=${encodeURIComponent(mailboxId)}`;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Mailboxes", href: mailboxes }, { label: "Make this a user" }];
  const data = await forPage(async () => ({
    mailbox: await getMailbox(deps, actor, accountId, mailboxId),
    people: await listPeople(deps, actor, accountId),
    delegation: can(actor, "delegation.read", accountId)
      ? await getMailboxDelegation(deps, actor, accountId, mailboxId)
      : null,
  }));
  const roles = grantableRoles(actor, accountId);
  const header = (
    <PageHeader
      title="Make this a user"
      description={
        data
          ? `${data.mailbox.address} becomes a person's mailbox: they sign in to the webmail and the console with it.`
          : "A person who signs in with this mailbox."
      }
      breadcrumbs={crumbs}
    />
  );
  const stop = (text: React.ReactNode) => (
    <>
      {header}
      <p className="am-body rounded-lg border px-4 py-3">{text}</p>
    </>
  );
  if (!data || roles.length === 0) {
    return stop("Your role in this account doesn't include adding users. Ask an owner if you need access.");
  }
  const { mailbox, people, delegation } = data;
  // Each person once, with their rights in the shared order.
  const delegates = (() => {
    if (!delegation) return null;
    const byPerson = new Map<string, { userId: string; name: string; email: string; rights: DelegationRight[] }>();
    const lists: [DelegationRight, typeof delegation.fullAccess][] = [
      ["full_access", delegation.fullAccess],
      ["send_as", delegation.sendAs],
      ["send_on_behalf", delegation.sendOnBehalf],
    ];
    for (const [right, list] of lists) {
      for (const p of list) {
        const row = byPerson.get(p.userId) ?? { ...p, rights: [] };
        row.rights.push(right);
        byPerson.set(p.userId, row);
      }
    }
    return [...byPerson.values()].map((r) => ({ ...r, rights: DELEGATION_RIGHTS.filter((x) => r.rights.includes(x)) }));
  })();
  const backLink = (
    <Link href={back} className="text-primary underline-offset-2 hover:underline">
      Back to the mailbox
    </Link>
  );
  if (mailbox.owner) return stop(<>This mailbox already belongs to someone. {backLink}</>);
  if (mailbox.status !== "active") {
    return stop(<>Only an active mailbox can become a user. {backLink}</>);
  }
  if (!people.limits.addPeople) {
    return stop(<>The {people.limits.planName} plan is for one person. Upgrade to add users.</>);
  }
  if (people.limits.used >= people.limits.max) {
    return stop(`This account already has ${String(people.limits.max)} people, counting pending invites.`);
  }
  return (
    <>
      {header}
      <AddUserWizard
        accountId={accountId}
        options={{ domains: [], maxQuotaGb: 0, defaultQuotaGb: 0, roles }}
        webmailUrl={env().WEBMAIL_URL}
        consoleUrl={env().APP_URL}
        existing={{ mailboxId: mailbox.id, address: mailbox.address, displayName: mailbox.displayName, delegates }}
      />
    </>
  );
}
