// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Copy, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ListEmpty, listClass, RowMenu, SortHeader, useSort } from "../console/data-list";
import { StatusText } from "../console/status-text";

export type AccountRow = {
  id: string;
  name: string;
  plan: string;
  active: boolean;
  status: string;
  members: number;
  mailboxes: number;
  created: string;
  createdAt: number;
};

const SORT_KEYS = {
  name: (r: AccountRow) => r.name,
  plan: (r: AccountRow) => r.plan,
  status: (r: AccountRow) => r.status,
  members: (r: AccountRow) => r.members,
  mailboxes: (r: AccountRow) => r.mailboxes,
  created: (r: AccountRow) => r.createdAt,
};

/**
 * Staff: customer accounts on this page of results (the server searches and pages; sorting here reorders the
 * page). Metadata only. Opening an account is recorded in that account's audit log.
 */
export function AccountList({ rows }: { rows: AccountRow[] }) {
  const { sorted, sort, toggle } = useSort(rows, SORT_KEYS, { key: "created", dir: "desc" });
  const [copied, setCopied] = useState<string | null>(null);
  if (rows.length === 0) return <ListEmpty>No accounts match.</ListEmpty>;
  return (
    <div className={listClass.wrap}>
      {copied && (
        <p role="status" className="am-small mb-2">
          Copied the account id of {copied}.
        </p>
      )}
      <table className={listClass.table}>
        <thead>
          <tr>
            <SortHeader label="Account" column="name" sort={sort} onSort={toggle} />
            <SortHeader label="Plan" column="plan" sort={sort} onSort={toggle} />
            <SortHeader label="Status" column="status" sort={sort} onSort={toggle} className="hidden sm:table-cell" />
            <SortHeader label="People" column="members" sort={sort} onSort={toggle} className="hidden md:table-cell" />
            <SortHeader
              label="Mailboxes"
              column="mailboxes"
              sort={sort}
              onSort={toggle}
              className="hidden md:table-cell"
            />
            <SortHeader label="Created" column="created" sort={sort} onSort={toggle} className="hidden lg:table-cell" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id} className={listClass.row}>
              <td className={listClass.td}>
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/platform/accounts/${a.id}`}
                    className="min-w-0 font-medium text-[14px] break-words underline-offset-2 hover:underline"
                  >
                    {a.name}
                  </Link>
                  <RowMenu
                    label={`Actions for ${a.name}`}
                    items={[
                      { label: "Open account", href: `/platform/accounts/${a.id}`, icon: <Info /> },
                      {
                        label: "Copy account id",
                        icon: <Copy />,
                        onSelect: () => {
                          void navigator.clipboard.writeText(a.id).then(() => {
                            setCopied(a.name);
                          });
                        },
                      },
                    ]}
                  />
                </div>
              </td>
              <td className={listClass.td}>{a.plan}</td>
              <td className={`${listClass.td} hidden sm:table-cell`}>
                <StatusText tone={a.active ? "success" : "warning"}>{a.active ? "Active" : a.status}</StatusText>
              </td>
              <td className={`${listClass.td} am-num hidden md:table-cell`}>{a.members}</td>
              <td className={`${listClass.td} am-num hidden md:table-cell`}>{a.mailboxes}</td>
              <td className={`${listClass.td} am-num hidden lg:table-cell`}>{a.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
