// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { MailboxStatus as Status } from "@anhourmail/core/mailboxes";
import { BookOpen, HardDrive, Info, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { callApi } from "../api";
import { bulkMessage, runBulk } from "../console/bulk";
import { CommandBar, CommandButton, CommandLink, ListSearch, OverflowMenu } from "../console/command-bar";
import {
  BulkBar,
  Checkbox,
  type ChipOption,
  FilterChips,
  ListEmpty,
  listClass,
  RowMenu,
  SortHeader,
  useSelection,
  useSort,
} from "../console/data-list";
import { ConfirmDialog } from "../console/flyout";
import { MAILBOX_STATUS, MailboxStatus } from "./mailbox-status";
import { StorageCell, UsedOfQuota } from "./storage-usage";

export type MailboxRow = {
  id: string;
  address: string;
  ownerEmail: string | null;
  quotaBytes: number;
  /** Storage used at the last measurement (every ~10 minutes); null until measured. */
  usedBytes: number | null;
  status: Status;
  applyFailed: boolean;
  /** Formatted on the server ("Restorable until …" while deleting). */
  restorableUntil: string | null;
};

type Filter = "all" | Status;

const SORT_KEYS = {
  address: (r: MailboxRow) => r.address,
  owner: (r: MailboxRow) => r.ownerEmail ?? "~",
  // By storage used; mailboxes not measured yet sort below an empty one.
  storage: (r: MailboxRow) => r.usedBytes ?? -1,
  status: (r: MailboxRow) => MAILBOX_STATUS[r.status].text,
};

const bulkAction =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] transition-colors hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:text-primary";

/**
 * The mailboxes list (console page template): command bar with "Add a mailbox", refresh, search and more; status
 * chips; a sortable list with a checkbox column and bulk suspend / resume / delete for people who manage
 * mailboxes, and a ⋮ menu per row. The address opens the details panel (`?mailbox=`).
 */
export function MailboxList({
  accountId,
  rows,
  canManage,
  openId,
  createHref,
  docsHref,
  graceDays,
}: {
  accountId: string;
  rows: MailboxRow[];
  canManage: boolean;
  openId: string | null;
  /** Where "Add a mailbox" goes, or null when a mailbox can't be added now. */
  createHref: string | null;
  docsHref: string;
  graceDays: number;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/accounts/${accountId}/mailboxes`;
  const api = `/api/accounts/${accountId}/mailboxes`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (q === "" || r.address.includes(q) || (r.ownerEmail ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query, filter]);
  const { sorted, sort, toggle } = useSort(visible, SORT_KEYS, { key: "address", dir: "asc" });
  const ids = useMemo(() => sorted.map((r) => r.id), [sorted]);
  const selection = useSelection(ids);

  const chips: ChipOption<Filter>[] = [
    { value: "all", label: "All", count: rows.length },
    ...(Object.keys(MAILBOX_STATUS) as Status[])
      .filter((s) => rows.some((r) => r.status === s))
      .map((s) => ({ value: s, label: MAILBOX_STATUS[s].text, count: rows.filter((r) => r.status === s).length })),
  ];

  async function bulk(action: "suspend" | "resume" | "delete", verb: string) {
    setBusy(true);
    setNotice(null);
    const r = await runBulk(selection.selected, (id) =>
      action === "delete"
        ? { url: `${api}/${id}`, method: "DELETE" }
        : { url: `${api}/${id}/${action}`, method: "POST" },
    );
    setBusy(false);
    setNotice({ error: r.failed.length > 0, text: bulkMessage(r, verb, "mailbox", "mailboxes") });
    selection.clear();
    router.refresh();
    return r;
  }

  async function single(id: string, action: "suspend" | "resume") {
    setNotice(null);
    const res = await callApi(`${api}/${id}/${action}`, { method: "POST" });
    if (!res.ok) setNotice({ error: true, text: res.message });
    router.refresh();
  }

  const selectedRows = rows.filter((r) => selection.selected.includes(r.id));

  return (
    <>
      <CommandBar
        label="Mailbox actions"
        end={
          <>
            <ListSearch label="Search mailboxes" value={query} onChange={setQuery} placeholder="Search this list" />
            <OverflowMenu items={[{ label: "Mailbox guide", href: docsHref, icon: <BookOpen />, external: true }]} />
          </>
        }
      >
        {createHref && (
          <CommandLink href={createHref} icon={<Plus />}>
            Add a mailbox
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

      {notice && (
        <p role={notice.error ? "alert" : "status"} className={`am-small ${notice.error ? "text-destructive" : ""}`}>
          {notice.text}
        </p>
      )}

      {canManage && (
        <BulkBar count={selection.selected.length} onClear={selection.clear}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void bulk("suspend", "Suspended")}
            className={bulkAction}
          >
            <Pause aria-hidden />
            Suspend
          </button>
          <button type="button" disabled={busy} onClick={() => void bulk("resume", "Resumed")} className={bulkAction}>
            <Play aria-hidden />
            Resume
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmDelete(true);
            }}
            className={bulkAction}
          >
            <Trash2 aria-hidden />
            Delete…
          </button>
        </BulkBar>
      )}

      {rows.length === 0 ? (
        <ListEmpty>No mailboxes yet.</ListEmpty>
      ) : (
        <div className={listClass.wrap}>
          <table className={listClass.table}>
            <thead>
              <tr>
                {canManage && (
                  <th scope="col" className={`${listClass.th} ${listClass.check}`}>
                    <Checkbox
                      label="Select all mailboxes"
                      checked={selection.all}
                      indeterminate={selection.some}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <SortHeader label="Address" column="address" sort={sort} onSort={toggle} />
                <SortHeader
                  label="Belongs to"
                  column="owner"
                  sort={sort}
                  onSort={toggle}
                  className="hidden md:table-cell"
                />
                <SortHeader
                  label="Storage"
                  column="storage"
                  sort={sort}
                  onSort={toggle}
                  className="hidden sm:table-cell"
                />
                <SortHeader label="Status" column="status" sort={sort} onSort={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => {
                const open = `${base}?mailbox=${m.id}`;
                const deleting = m.status === "deleting";
                return (
                  <tr
                    key={m.id}
                    data-open={m.id === openId}
                    data-selected={selection.selected.includes(m.id)}
                    className={listClass.row}
                  >
                    {canManage && (
                      <td className={`${listClass.td} ${listClass.check}`}>
                        <Checkbox
                          label={`Select ${m.address}`}
                          checked={selection.selected.includes(m.id)}
                          onChange={(on) => {
                            selection.toggle(m.id, on);
                          }}
                        />
                      </td>
                    )}
                    <td className={listClass.td}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <Link
                            href={open}
                            scroll={false}
                            className="min-w-0 font-mono font-medium text-[14px] break-words text-foreground underline-offset-2 hover:underline"
                          >
                            {m.address}
                          </Link>
                          <span className="am-micro truncate md:hidden">{m.ownerEmail ?? "Not assigned"}</span>
                          <span className="am-micro sm:hidden">
                            <UsedOfQuota usedBytes={m.usedBytes} quotaBytes={m.quotaBytes} />
                          </span>
                        </div>
                        <RowMenu
                          label={`Actions for ${m.address}`}
                          items={[
                            { label: "Open details", href: open, icon: <Info /> },
                            ...(canManage && !deleting
                              ? [
                                  { label: "Change storage", href: `${open}&tab=storage`, icon: <HardDrive /> },
                                  m.status === "suspended"
                                    ? { label: "Resume", onSelect: () => void single(m.id, "resume"), icon: <Play /> }
                                    : {
                                        label: "Suspend",
                                        onSelect: () => void single(m.id, "suspend"),
                                        icon: <Pause />,
                                      },
                                  { label: "Delete…", href: `${open}&tab=access`, icon: <Trash2 />, danger: true },
                                ]
                              : []),
                            ...(canManage && deleting
                              ? [{ label: "Restore…", href: `${open}&tab=access`, icon: <RefreshCw /> }]
                              : []),
                          ]}
                        />
                      </div>
                    </td>
                    <td className={`${listClass.td} hidden break-all md:table-cell`}>
                      {m.ownerEmail ?? <span className="text-muted-foreground">Not assigned</span>}
                    </td>
                    <td className={`${listClass.td} hidden sm:table-cell`}>
                      <StorageCell usedBytes={m.usedBytes} quotaBytes={m.quotaBytes} />
                    </td>
                    <td className={listClass.td}>
                      <div className="flex flex-col items-start gap-0.5">
                        <MailboxStatus status={m.status} applyFailed={m.applyFailed} />
                        {m.restorableUntil && (
                          <span className="am-micro am-num">Restorable until {m.restorableUntil}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length === 0 && <ListEmpty>Nothing matches this search or filter.</ListEmpty>}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={
            selectedRows.length === 1 ? "Delete this mailbox?" : `Delete ${String(selectedRows.length)} mailboxes?`
          }
          confirmLabel="Delete"
          pendingLabel="Deleting…"
          onCancel={() => {
            setConfirmDelete(false);
          }}
          onConfirm={async () => {
            await bulk("delete", "Deleted");
            setConfirmDelete(false);
            return null;
          }}
        >
          <p>
            {selectedRows.map((r) => r.address).join(", ")} will be suspended straight away: nobody can sign in and mail
            to {selectedRows.length === 1 ? "it" : "them"} is refused. Everything is kept and can be restored for{" "}
            {graceDays} days, then it&apos;s deleted for good with all its mail.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
