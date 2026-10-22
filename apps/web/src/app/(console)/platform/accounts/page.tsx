// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { searchAccounts } from "@anhourmail/core/platform";
import { PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";
import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";

import { CommandBar, CommandLink } from "@/components/console/command-bar";
import { AccountList } from "@/components/platform/account-list";
import { secondaryButtonClass } from "@/components/ui-classes";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Customer accounts" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

export default async function CustomerAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  // Customers and staff without the permission never learn this page exists.
  if (!can(actor, "platform.accounts.read")) notFound();
  const sp = await searchParams;
  const result = await searchAccounts(container().deps, actor, { query: sp.q, page: sp.page });
  const href = (page: number) => {
    const q = new URLSearchParams();
    if (result.query) q.set("q", result.query);
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/platform/accounts?${s}` : "/platform/accounts";
  };

  return (
    <>
      <PageHeader
        title="Customer accounts"
        description="Look up an account by name, id or a member's email. Metadata only: there is no way to read mail from here."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Customer accounts" }]}
      />
      <CommandBar
        label="Customer account actions"
        end={
          <form method="get" action="/platform/accounts" role="search" className="flex w-full gap-1 sm:w-auto">
            <div className="relative w-full sm:w-72">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                id="account-search"
                name="q"
                type="search"
                aria-label="Search accounts"
                defaultValue={result.query}
                placeholder="Name, account id or email"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="h-8 w-full rounded-md border bg-background pr-2 pl-8 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="submit"
              className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-[14px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Search
            </button>
          </form>
        }
      >
        <CommandLink href={href(result.page)} icon={<RefreshCw />}>
          Refresh
        </CommandLink>
        {result.query && (
          <CommandLink href="/platform/accounts" icon={<X />}>
            Clear search
          </CommandLink>
        )}
      </CommandBar>
      <p className="am-small am-num">
        {result.total === 1 ? "1 account" : `${String(result.total)} accounts`}
        {result.query ? ` matching “${result.query}”` : ""}
      </p>
      <AccountList
        rows={result.rows.map((a) => ({
          id: a.id,
          name: a.name,
          plan: PLANS[a.plan].name,
          active: a.status === "active",
          status: a.status,
          members: a.members,
          mailboxes: a.mailboxes,
          created: dateFmt.format(a.createdAt),
          createdAt: a.createdAt.getTime(),
        }))}
      />
      {result.pages > 1 && (
        <nav aria-label="Account pages" className="flex flex-wrap items-center justify-between gap-3">
          {result.page > 1 ? (
            <Link href={href(result.page - 1)} className={secondaryButtonClass}>
              <ChevronLeft className="size-4" aria-hidden />
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="am-small am-num">
            Page {result.page} of {result.pages}
          </span>
          {result.page < result.pages ? (
            <Link href={href(result.page + 1)} className={secondaryButtonClass}>
              Next
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
