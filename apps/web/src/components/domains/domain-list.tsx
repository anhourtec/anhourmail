// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { BookOpen, Info, ListChecks, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { CommandBar, CommandButton, CommandLink, ListSearch, OverflowMenu } from "../console/command-bar";
import { type ChipOption, FilterChips, ListEmpty, listClass, RowMenu, SortHeader, useSort } from "../console/data-list";
import { StatusText } from "../console/status-text";
import { DOMAIN_STATE, type DomainState } from "./domain-status";

export type DomainRow = { id: string; name: string; state: DomainState; added: string; addedAt: number };

type Filter = "all" | DomainState;

const SORT_KEYS = {
  name: (r: DomainRow) => r.name,
  status: (r: DomainRow) => DOMAIN_STATE[r.state].text,
  added: (r: DomainRow) => r.addedAt,
};

/**
 * The domains list (console page template): "Add a domain", refresh, search; status chips; a sortable list whose
 * names open the details panel (`?domain=`) with the DNS records. No bulk actions: each removal is checked on its
 * own (the server refuses while mailboxes or aliases use the domain).
 */
export function DomainList({
  accountId,
  rows,
  openId,
  createHref,
  docsHref,
}: {
  accountId: string;
  rows: DomainRow[];
  openId: string | null;
  createHref: string | null;
  docsHref: string;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const base = `/accounts/${accountId}/domains`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (filter === "all" || r.state === filter) && (q === "" || r.name.includes(q)));
  }, [rows, query, filter]);
  const { sorted, sort, toggle } = useSort(visible, SORT_KEYS, { key: "name", dir: "asc" });

  const chips: ChipOption<Filter>[] = [
    { value: "all", label: "All", count: rows.length },
    ...(Object.keys(DOMAIN_STATE) as DomainState[])
      .filter((s) => rows.some((r) => r.state === s))
      .map((s) => ({ value: s, label: DOMAIN_STATE[s].text, count: rows.filter((r) => r.state === s).length })),
  ];

  return (
    <>
      <CommandBar
        label="Domain actions"
        end={
          <>
            <ListSearch label="Search domains" value={query} onChange={setQuery} placeholder="Search this list" />
            <OverflowMenu
              items={[{ label: "Custom domain guide", href: docsHref, icon: <BookOpen />, external: true }]}
            />
          </>
        }
      >
        {createHref && (
          <CommandLink href={createHref} icon={<Plus />}>
            Add a domain
          </CommandLink>
        )}
        <CommandButton
          icon={<RefreshCw />}
          busy={refreshing}
          onClick={() => {
            startRefresh(() => {
              router.refresh();
            });
          }}
        >
          Refresh
        </CommandButton>
      </CommandBar>

      {rows.length > 0 && <FilterChips label="Status" options={chips} value={filter} onChange={setFilter} />}

      {rows.length === 0 ? (
        <ListEmpty>No domains yet.</ListEmpty>
      ) : (
        <div className={listClass.wrap}>
          <table className={listClass.table}>
            <thead>
              <tr>
                <SortHeader label="Domain" column="name" sort={sort} onSort={toggle} />
                <SortHeader label="Status" column="status" sort={sort} onSort={toggle} />
                <SortHeader label="Added" column="added" sort={sort} onSort={toggle} className="hidden sm:table-cell" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const open = `${base}?domain=${d.id}`;
                const st = DOMAIN_STATE[d.state];
                return (
                  <tr key={d.id} data-open={d.id === openId} className={listClass.row}>
                    <td className={listClass.td}>
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={open}
                          scroll={false}
                          className="min-w-0 font-mono font-medium text-[14px] break-all underline-offset-2 hover:underline"
                        >
                          {d.name}
                        </Link>
                        <RowMenu
                          label={`Actions for ${d.name}`}
                          items={[
                            { label: "Open details", href: open, icon: <Info /> },
                            { label: "DNS records", href: `${open}&tab=records`, icon: <ListChecks /> },
                          ]}
                        />
                      </div>
                    </td>
                    <td className={listClass.td}>
                      <StatusText tone={st.tone}>{st.text}</StatusText>
                    </td>
                    <td className={`${listClass.td} am-num hidden sm:table-cell`}>{d.added}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length === 0 && <ListEmpty>Nothing matches this search or filter.</ListEmpty>}
        </div>
      )}
    </>
  );
}
