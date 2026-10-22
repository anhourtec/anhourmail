// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { listMyAppPasswords, type MailboxAppPasswords } from "@anhourmail/core/app-passwords";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AppPasswordList } from "@/components/app-passwords/app-password-list";
import { CreateAppPassword } from "@/components/app-passwords/create-app-password";
import { MailAppSettings } from "@/components/app-passwords/mail-app-settings";
import { StatusText } from "@/components/console/status-text";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { platform } from "@/server/platform";

export const metadata: Metadata = { title: "App passwords" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="am-h3">
          {title}
        </h2>
        {description && <p className="am-small max-w-[80ch]">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function why(m: MailboxAppPasswords): string | null {
  if (m.mailboxStatus === "suspended")
    return "This mailbox is suspended: its app passwords don't work until it's resumed.";
  if (m.mailboxStatus === "deleting") return "This mailbox is being deleted: its app passwords don't work any more.";
  if (m.mailboxStatus !== "active") return "This mailbox is still being set up. Come back in a minute.";
  if (m.appPasswords.length >= m.limit) {
    return `A mailbox can have ${String(m.limit)} app passwords. Revoke one you no longer use to make another.`;
  }
  return null;
}

/**
 * App passwords: the person's own mailboxes in this account with their app passwords (create with a step-up, see once,
 * revoke), and the settings to type into a mail app. Admins see others' app passwords on the mailbox panel.
 */
export default async function AppPasswordsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => listMyAppPasswords(container().deps, actor, accountId));
  const crumbs = [{ label: "Home", href: "/" }, { label: "App passwords" }];
  if (!data) {
    return (
      <>
        <PageHeader title="App passwords" breadcrumbs={crumbs} />
        <p className="am-body">
          Your role in this account doesn&apos;t include app passwords. Ask an owner if you need one.
        </p>
      </>
    );
  }
  const docs = `${env().SITE_URL.replace(/\/$/, "")}/docs/clients/app-passwords`;

  return (
    <>
      <PageHeader
        title="App passwords"
        description="Phone and desktop mail apps sign in with an app password: one per app, shown once, and revoked on its own if you lose the device."
        breadcrumbs={crumbs}
      />

      {data.length === 0 ? (
        <p className="am-body rounded-lg border px-4 py-3">
          You don&apos;t have a mailbox in this account yet. Ask an owner to create one for you, then come back here.
        </p>
      ) : (
        data.map((m) => {
          const note = why(m);
          return (
            <Section
              key={m.mailboxId}
              id={`mb-${m.mailboxId}`}
              title={<span className="font-mono">{m.address}</span>}
              description={`App passwords for this mailbox (${String(m.appPasswords.length)} of ${String(m.limit)}).`}
            >
              {note && <StatusText tone={m.mailboxStatus === "active" ? "info" : "warning"}>{note}</StatusText>}
              {m.canCreate && <CreateAppPassword accountId={accountId} mailboxId={m.mailboxId} address={m.address} />}
              <AppPasswordList
                accountId={accountId}
                mailboxId={m.mailboxId}
                address={m.address}
                canRevoke={m.canRevoke}
                rows={m.appPasswords.map((p) => ({
                  id: p.id,
                  name: p.name,
                  protocols: p.protocols,
                  revoking: p.status === "revoking",
                  created: dateFmt.format(p.createdAt),
                }))}
              />
            </Section>
          );
        })
      )}

      <Section
        id="settings"
        title="Settings for your mail app"
        description="Most apps fill these in when you type your email address. If yours asks, use these values."
      >
        <MailAppSettings address={data.length === 1 ? (data[0]?.address ?? null) : null} platform={platform()} />
        <p className="am-small">
          Step-by-step guides are in the{" "}
          <a href={docs} className="text-primary underline-offset-2 hover:underline">
            app passwords guide
          </a>
          .
        </p>
      </Section>
    </>
  );
}
