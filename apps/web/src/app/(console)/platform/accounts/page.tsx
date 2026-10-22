// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { searchAccounts } from "@anhourmail/core/platform";
import { PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Customer accounts" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
const th = "am-mono px-4 py-2.5 font-normal";

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
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Customer accounts" }]}
      />
      <form method="get" action="/platform/accounts" role="search" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="account-search" className="sr-only">
          Search accounts
        </label>
        <input
          id="account-search"
          name="q"
          type="search"
          defaultValue={result.query}
          placeholder="Name, account id or email"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          className={`${inputClass} sm:max-w-md`}
        />
        <button type="submit" className={`${primaryButtonClass} w-fit`}>
          <Search className="size-4" aria-hidden />
          Search
        </button>
      </form>
      <p className="am-small am-num">
        {result.total === 1 ? "1 account" : `${String(result.total)} accounts`}
        {result.query ? ` matching “${result.query}”` : ""}
      </p>
      {result.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left">
            <thead className="border-b bg-muted/50">
              <tr>
                <th scope="col" className={th}>
                  Account
                </th>
                <th scope="col" className={th}>
                  Plan
                </th>
                <th scope="col" className={`${th} hidden sm:table-cell`}>
                  Status
                </th>
                <th scope="col" className={`${th} hidden md:table-cell`}>
                  People
                </th>
                <th scope="col" className={`${th} hidden md:table-cell`}>
                  Mailboxes
                </th>
                <th scope="col" className={`${th} hidden lg:table-cell`}>
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/platform/accounts/${a.id}`}
                      className="am-body break-words underline-offset-2 hover:underline"
                    >
                      {a.name}
                    </Link>
                  </td>
                  <td className="am-small px-4 py-3">{PLANS[a.plan].name}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <span className={`am-status am-status--${a.status === "active" ? "success" : "warning"}`}>
                      {a.status === "active" ? "Active" : a.status}
                    </span>
                  </td>
                  <td className="am-small am-num hidden px-4 py-3 md:table-cell">{a.members}</td>
                  <td className="am-small am-num hidden px-4 py-3 md:table-cell">{a.mailboxes}</td>
                  <td className="am-small am-num hidden px-4 py-3 lg:table-cell">{dateFmt.format(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
