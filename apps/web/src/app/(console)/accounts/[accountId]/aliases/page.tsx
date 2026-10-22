// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AliasActions } from "@/components/aliases/alias-actions";
import { CreateAliasForm } from "@/components/aliases/create-alias-form";
import { CopyValue } from "@/components/copy-value";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Aliases" };

const usage = (l: { used: number; max: number | null }, one: string, many: string) =>
  l.max === null
    ? `${String(l.used)} ${l.used === 1 ? one : many}`
    : `${String(l.used)} of ${String(l.max)} ${l.max === 1 ? one : many}`;

export default async function AliasesPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => listAliases(container().deps, actor, accountId));
  const crumbs = [{ label: "Overview", href: "/" }, { label: "Aliases" }];
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

  return (
    <>
      <PageHeader
        title="Aliases"
        description="More addresses for the same mailbox. Masked aliases are random ones to give a single site, so you can turn them off when they start getting spam."
        breadcrumbs={crumbs}
      />
      <p className="am-small am-num">
        In this account: {usage(limits.alias, "alias", "aliases")} ·{" "}
        {usage(limits.masked, "masked alias", "masked aliases")}
      </p>

      {mailboxes.length === 0 ? (
        <p className="am-body rounded-xl border px-4 py-3">
          Aliases deliver to a mailbox, and you don&apos;t have one to use yet.{" "}
          {can(actor, "mailbox.manage", accountId) ? (
            <Link href={`/accounts/${accountId}/mailboxes`} className="underline underline-offset-2">
              Create a mailbox
            </Link>
          ) : (
            "Ask an owner to create one for you."
          )}
        </p>
      ) : room.alias || room.masked ? (
        <CreateAliasForm accountId={accountId} options={{ mailboxes, domains, room }} />
      ) : (
        <p className="am-small">This account has all the aliases its plan includes.</p>
      )}

      {aliases.length === 0 ? (
        <p className="am-small">No aliases yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left">
            <thead className="border-b bg-muted/50">
              <tr>
                <th scope="col" className="am-mono px-4 py-2.5 font-normal">
                  Address
                </th>
                <th scope="col" className="am-mono hidden px-4 py-2.5 font-normal md:table-cell">
                  Delivers to
                </th>
                <th scope="col" className="am-mono hidden px-4 py-2.5 font-normal lg:table-cell">
                  Note
                </th>
                <th scope="col" className="am-mono px-4 py-2.5 text-right font-normal">
                  <span className="sr-only">On or off, and delete</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {aliases.map((a) => (
                <tr key={a.id} className={a.enabled && !a.mailbox.deleting ? "" : "text-muted-foreground"}>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <CopyValue value={a.address} label={a.address} />
                      <span className="am-micro break-all md:hidden">to {a.mailbox.address}</span>
                      <span className="flex flex-wrap gap-1.5">
                        <span className={`am-status am-status--${a.kind === "masked" ? "info" : "neutral"}`}>
                          {a.kind === "masked" ? "Masked" : "Alias"}
                        </span>
                        {!a.enabled && <span className="am-status am-status--warning">Off</span>}
                        {a.mailbox.deleting && (
                          <span className="am-status am-status--warning">Mailbox being deleted</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="am-code hidden break-all px-4 py-3 md:table-cell">{a.mailbox.address}</td>
                  <td className="am-small hidden px-4 py-3 lg:table-cell">{a.description ?? "—"}</td>
                  <td className="px-4 py-3">
                    <AliasActions
                      accountId={accountId}
                      aliasId={a.id}
                      address={a.address}
                      enabled={a.enabled}
                      locked={a.mailbox.deleting}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
