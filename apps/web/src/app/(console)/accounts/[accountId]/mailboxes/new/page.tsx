// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { mailboxOptions } from "@anhourmail/core/mailboxes";
import { addUserAvailability, type Availability, grantableRoles, listPeople } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddUserWizard } from "@/components/mailboxes/add-user-wizard";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { mailboxRoom } from "@/server/people-actions";

export const metadata: Metadata = { title: "Add a user" };

/**
 * "Add a user": a four-step page (Basics, Role, Optional settings, Review) that creates a mailbox and a person who
 * signs in with it, with the chosen role (`addUser`). Needs `mailbox.manage` and a plan with people; the role list is
 * what this admin may grant. Whether it can be used now is core `addUserAvailability`, the same answer the sidebar,
 * Home and the Mailboxes list use.
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
  const availability = addUserAvailability({
    permitted: data !== null && roles.length > 0,
    people: data?.people.limits ?? null,
    mailboxes: data ? mailboxRoom(data.options) : null,
  });
  /** Why it can't be used, with the next step linked where there is one. */
  const why = (a: Exclude<Availability, { state: "ready" }>): React.ReactNode => {
    if (a.code === "single_person_plan") {
      return (
        <>
          {a.reason} Upgrade to add users, or{" "}
          <Link href={`${mailboxes}?new=1`} className="text-primary underline-offset-2 hover:underline">
            add a shared mailbox
          </Link>{" "}
          instead.
        </>
      );
    }
    if (a.code === "no_domain") {
      return (
        <>
          {a.reason}{" "}
          <Link
            href={`/accounts/${accountId}/domains?new=1`}
            className="text-primary underline-offset-2 hover:underline"
          >
            Add and verify a domain
          </Link>{" "}
          first.
        </>
      );
    }
    return a.reason;
  };
  // Not ready, or (the same thing: no data means not permitted) nothing to build the form from.
  if (availability.state !== "ready" || !data) return stop(availability.state === "ready" ? null : why(availability));
  const { options } = data;
  const domains = [
    ...options.domains.map((d) => ({ id: d.id, name: d.name, free: false })),
    ...(options.platform.allowed && options.platform.emailVerified
      ? [{ id: options.platform.id, name: options.platform.domain, free: true }]
      : []),
  ];
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
