// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AliasList } from "@/components/aliases/alias-list";
import { CreateAliasForm } from "@/components/aliases/create-alias-form";
import { UrlFlyout } from "@/components/console/flyout";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "Aliases" };

const usage = (l: { used: number; max: number | null }, one: string, many: string) =>
  l.max === null
    ? `${String(l.used)} ${l.used === 1 ? one : many}`
    : `${String(l.used)} of ${String(l.max)} ${l.max === 1 ? one : many}`;

/** Aliases (console page template). `?new=1` opens the "Add an alias" panel; `?q=` pre-fills the list's search. */
export default async function AliasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { accountId } = await params;
  const sp = await searchParams;
  const actor = await requireUser();
  const data = await forPage(() => listAliases(container().deps, actor, accountId));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Aliases" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Aliases" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include aliases. Ask an owner if you need access.</p>
      </>
    );
  }
  const { aliases, mailboxes, domains, limits } = data;
  const room = {
    alias: limits.alias.max === null || limits.alias.used < limits.alias.max,
    masked: limits.masked.max === null || limits.masked.used < limits.masked.max,
  };
  const path = `/accounts/${accountId}/aliases`;
  const canAdd = mailboxes.length > 0 && (room.alias || room.masked);

  return (
    <>
      <PageHeader
        title="Aliases"
        description="More addresses for the same mailbox. Masked aliases are random ones to give a single site, so you can turn them off when they start getting spam."
        breadcrumbs={crumbs}
      />
      <p className="am-small am-num -mt-2">
        In this account: {usage(limits.alias, "alias", "aliases")} ·{" "}
        {usage(limits.masked, "masked alias", "masked aliases")}
      </p>
      {mailboxes.length === 0 ? (
        <p className="am-body rounded-lg border px-4 py-3">
          Aliases deliver to a mailbox, and you don&apos;t have one to use yet.{" "}
          {can(actor, "mailbox.manage", accountId) ? (
            <Link
              href={`/accounts/${accountId}/mailboxes?new=1`}
              className="text-primary underline-offset-2 hover:underline"
            >
              Create a mailbox
            </Link>
          ) : (
            "Ask an owner to create one for you."
          )}
        </p>
      ) : (
        !canAdd && <p className="am-small">This account has all the aliases its plan includes.</p>
      )}

      <AliasList
        accountId={accountId}
        rows={aliases.map((a) => ({
          id: a.id,
          address: a.address,
          kind: a.kind,
          enabled: a.enabled,
          note: a.description,
          mailbox: a.mailbox.address,
          locked: a.mailbox.deleting,
        }))}
        createHref={canAdd ? `${path}?new=1` : null}
        docsHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/aliases`}
        initialQuery={param(sp, "q") ?? ""}
      />

      {canAdd && param(sp, "new") === "1" && (
        <UrlFlyout label="Add an alias" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Add an alias</h2>
              <p className="am-small">
                Another address for one of your mailboxes: one you choose, or a random masked one.
              </p>
            </div>
            <CreateAliasForm accountId={accountId} options={{ mailboxes, domains, room }} />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
