// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { getMailbox } from "@anhourmail/core/mailboxes";
import { grantableRoles, listPeople } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddUserWizard } from "@/components/mailboxes/add-user-wizard";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Make this a user" };

/**
 * "Make this a user" for a person-less mailbox (a shared address): the "Add a user" steps without the address and
 * storage (Basics, Role, Optional settings, Review), ending in `makeMailboxUser`. Needs `mailbox.manage`, a role this
 * admin may grant and a plan with room for another person; the server checks all of it again.
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
  const { mailbox, people } = data;
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
        existing={{ mailboxId: mailbox.id, address: mailbox.address, displayName: mailbox.displayName }}
      />
    </>
  );
}
