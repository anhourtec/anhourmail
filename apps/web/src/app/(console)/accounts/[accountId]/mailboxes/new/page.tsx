// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { mailboxOptions } from "@anhourmail/core/mailboxes";
import { grantableRoles, listPeople } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddUserWizard } from "@/components/mailboxes/add-user-wizard";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Add a user" };

/**
 * "Add a user": a four-step page (Basics, Role, Optional settings, Review) that creates a mailbox and a person who
 * signs in with it, with the chosen role (`addUser`). Needs `mailbox.manage` and a plan with people; the role list is
 * what this admin may grant.
 */
export default async function AddUserPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const deps = container().deps;
  const mailboxes = `/accounts/${accountId}/mailboxes`;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Mailboxes", href: mailboxes }, { label: "Add a user" }];
  const data = await forPage(async () => ({
    options: await mailboxOptions(deps, actor, accountId),
    people: await listPeople(deps, actor, accountId),
  }));
  const roles = grantableRoles(actor, accountId);
  const header = (
    <PageHeader
      title="Add a user"
      description="A person with their own mailbox. They sign in to the webmail and the console with the new address."
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
  const { options, people } = data;
  if (!people.limits.addPeople) {
    return stop(
      <>
        The {people.limits.planName} plan is for one person. Upgrade to add users, or{" "}
        <Link href={`${mailboxes}?new=1`} className="text-primary underline-offset-2 hover:underline">
          add a shared address
        </Link>{" "}
        instead.
      </>,
    );
  }
  if (people.limits.used >= people.limits.max) {
    return stop(`This account already has ${String(people.limits.max)} people, counting pending invites.`);
  }
  const domains = [
    ...options.domains.map((d) => ({ id: d.id, name: d.name, free: false })),
    ...(options.platform.allowed && options.platform.emailVerified
      ? [{ id: options.platform.id, name: options.platform.domain, free: true }]
      : []),
  ];
  if (options.remaining <= 0) return stop("This account has all the mailboxes its plan includes.");
  if (options.maxQuotaGb < 1)
    return stop("All of the account's storage is assigned. Lower another mailbox's storage first.");
  if (domains.length === 0) {
    return stop(
      <>
        New users need an address on your own domain.{" "}
        <Link href={`/accounts/${accountId}/domains?new=1`} className="text-primary underline-offset-2 hover:underline">
          Add and verify a domain
        </Link>{" "}
        first.
      </>,
    );
  }
  return (
    <>
      {header}
      <AddUserWizard
        accountId={accountId}
        options={{ domains, maxQuotaGb: options.maxQuotaGb, defaultQuotaGb: options.defaultQuotaGb, roles }}
        webmailUrl={env().WEBMAIL_URL}
        consoleUrl={env().APP_URL}
      />
    </>
  );
}
