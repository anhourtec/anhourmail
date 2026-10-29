// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { BookOpen, Copy, Plus, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
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
import { StatusText } from "../console/status-text";

export type AliasRow = {
  id: string;
  address: string;
  kind: "alias" | "masked";
  enabled: boolean;
  note: string | null;
  mailbox: string;
  /** The mailbox is in its deletion grace period: the alias is off on the mail server and can't be turned on. */
  locked: boolean;
  /** An administrator turned it off. Only an administrator can turn it back on or delete it (the server decides). */
  adminLocked: boolean;
};

type Filter = "all" | "alias" | "masked" | "off";

const SORT_KEYS = {
  address: (r: AliasRow) => r.address,
  kind: (r: AliasRow) => r.kind,
  mailbox: (r: AliasRow) => r.mailbox,
  note: (r: AliasRow) => r.note ?? "~",
  state: (r: AliasRow) => (r.enabled ? 0 : 1),
};

const bulkAction =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] transition-colors hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:text-primary";

/** On/off switch for one alias. Applies on the mail server once the worker syncs the mailbox. */
function AliasSwitch({
  row,
  held,
  onError,
  url,
}: {
  row: AliasRow;
  /** Turned off by an administrator and this person can't lift it. */
  held: boolean;
  onError: (m: string) => void;
  url: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={row.enabled}
      aria-label={`Receive mail at ${row.address}`}
      disabled={pending || row.locked || held}
      onClick={() => {
        setPending(true);
        void callApi(url, { method: "PATCH", body: { enabled: !row.enabled } }).then((res) => {
          setPending(false);
          if (!res.ok) onError(res.message);
          router.refresh();
        });
      }}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border bg-muted transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-checked:border-primary aria-checked:bg-primary disabled:opacity-60"
    >
      <span
        aria-hidden
        className={`size-3.5 rounded-full bg-background shadow-sm transition-transform ${row.enabled ? "translate-x-[1.05rem]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

/**
 * The aliases list (console page template): "Add an alias", search, type chips, a sortable list with checkboxes
 * and bulk on / off / delete, an on/off switch per row and a ⋮ menu (copy, on/off, delete). Members see only their
 * own mailboxes' aliases — the server decides that. An alias an administrator turned off says so; for someone who
 * can't lift that (`canLift` false) its switch, "Turn on" and "Delete…" are disabled (the server refuses them too).
 */
export function AliasList({
  accountId,
  rows,
  createHref,
  docsHref,
  initialQuery,
  canLift,
}: {
  accountId: string;
  rows: AliasRow[];
  createHref: string | null;
  docsHref: string;
  initialQuery: string;
  /** The viewer manages every mailbox's aliases (`alias.manage.any`), so an administrator's lock doesn't hold them. */
  canLift: boolean;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const api = `/api/accounts/${accountId}/aliases`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "all" || (filter === "off" ? !r.enabled : r.kind === filter)) &&
        (q === "" || r.address.includes(q) || r.mailbox.includes(q) || (r.note ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query, filter]);
  const { sorted, sort, toggle } = useSort(visible, SORT_KEYS, { key: "address", dir: "asc" });
  const ids = useMemo(() => sorted.map((r) => r.id), [sorted]);
  const selection = useSelection(ids);

  const chips: ChipOption<Filter>[] = [
    { value: "all", label: "All", count: rows.length },
    { value: "alias", label: "Aliases", count: rows.filter((r) => r.kind === "alias").length },
    { value: "masked", label: "Masked", count: rows.filter((r) => r.kind === "masked").length },
    { value: "off", label: "Off", count: rows.filter((r) => !r.enabled).length },
  ];

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    setNotice(null);
    const r = await runBulk(selection.selected, (id) => ({ url: `${api}/${id}`, method: "PATCH", body: { enabled } }));
    setBusy(false);
    setNotice({
      error: r.failed.length > 0,
      text: bulkMessage(r, enabled ? "Turned on" : "Turned off", "alias", "aliases"),
    });
    selection.clear();
    router.refresh();
  }

  async function remove(targets: string[]): Promise<string | null> {
    setNotice(null);
    const r = await runBulk(targets, (id) => ({ url: `${api}/${id}`, method: "DELETE" }));
    selection.clear();
    router.refresh();
    if (targets.length === 1) return r.failed[0] ?? null;
    setNotice({ error: r.failed.length > 0, text: bulkMessage(r, "Deleted", "alias", "aliases") });
    return null;
  }

  const confirming = confirm ? rows.filter((r) => confirm.includes(r.id)) : [];

  return (
    <>
      <CommandBar
        label="Alias actions"
        end={
          <>
            <ListSearch label="Search aliases" value={query} onChange={setQuery} placeholder="Search this list" />
            <OverflowMenu items={[{ label: "Aliases guide", href: docsHref, icon: <BookOpen />, external: true }]} />
          </>
        }
      >
        {createHref && (
          <CommandLink href={createHref} icon={<Plus />}>
            Add an alias
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

      {rows.length > 0 && <FilterChips label="Show" options={chips} value={filter} onChange={setFilter} />}

      {notice && (
        <p role={notice.error ? "alert" : "status"} className={`am-small ${notice.error ? "text-destructive" : ""}`}>
          {notice.text}
        </p>
      )}

      <BulkBar count={selection.selected.length} onClear={selection.clear}>
        <button type="button" disabled={busy} onClick={() => void setEnabled(true)} className={bulkAction}>
          <Power aria-hidden />
          Turn on
        </button>
        <button type="button" disabled={busy} onClick={() => void setEnabled(false)} className={bulkAction}>
          <PowerOff aria-hidden />
          Turn off
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirm(selection.selected);
          }}
          className={bulkAction}
        >
          <Trash2 aria-hidden />
          Delete…
        </button>
      </BulkBar>

      {rows.length === 0 ? (
        <ListEmpty>No aliases yet.</ListEmpty>
      ) : (
        <div className={listClass.wrap}>
          <table className={listClass.table}>
            <thead>
              <tr>
                <th scope="col" className={`${listClass.th} ${listClass.check}`}>
                  <Checkbox
                    label="Select all aliases"
                    checked={selection.all}
                    indeterminate={selection.some}
                    onChange={selection.toggleAll}
                  />
                </th>
                <SortHeader label="Address" column="address" sort={sort} onSort={toggle} />
                <SortHeader label="Type" column="kind" sort={sort} onSort={toggle} />
                <SortHeader
                  label="Delivers to"
                  column="mailbox"
                  sort={sort}
                  onSort={toggle}
                  className="hidden md:table-cell"
                />
                <SortHeader label="Note" column="note" sort={sort} onSort={toggle} className="hidden lg:table-cell" />
                <SortHeader label="Receiving" column="state" sort={sort} onSort={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id} data-selected={selection.selected.includes(a.id)} className={listClass.row}>
                  <td className={`${listClass.td} ${listClass.check}`}>
                    <Checkbox
                      label={`Select ${a.address}`}
                      checked={selection.selected.includes(a.id)}
                      onChange={(on) => {
                        selection.toggle(a.id, on);
                      }}
                    />
                  </td>
                  <td className={listClass.td}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <span
                          className={`font-mono font-medium text-[14px] break-all ${a.enabled && !a.locked ? "" : "text-muted-foreground"}`}
                        >
                          {a.address}
                        </span>
                        <span className="am-micro break-all md:hidden">to {a.mailbox}</span>
                        {a.locked && <span className="am-micro">Mailbox being deleted</span>}
                        {a.adminLocked && <span className="am-micro">Turned off by an administrator</span>}
                      </div>
                      <RowMenu
                        label={`Actions for ${a.address}`}
                        items={[
                          {
                            label: "Copy address",
                            icon: <Copy />,
                            onSelect: () => {
                              void navigator.clipboard.writeText(a.address).then(() => {
                                setNotice({ error: false, text: `Copied ${a.address}.` });
                              });
                            },
                          },
                          {
                            label: a.enabled ? "Turn off" : "Turn on",
                            icon: a.enabled ? <PowerOff /> : <Power />,
                            disabled: a.locked || (a.adminLocked && !canLift),
                            onSelect: () => {
                              void callApi(`${api}/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }).then(
                                (res) => {
                                  if (!res.ok) setNotice({ error: true, text: res.message });
                                  router.refresh();
                                },
                              );
                            },
                          },
                          {
                            label: "Delete…",
                            icon: <Trash2 />,
                            danger: true,
                            disabled: a.adminLocked && !canLift,
                            onSelect: () => {
                              setConfirm([a.id]);
                            },
                          },
                        ]}
                      />
                    </div>
                  </td>
                  <td className={listClass.td}>{a.kind === "masked" ? "Masked" : "Alias"}</td>
                  <td className={`${listClass.td} hidden font-mono text-[13px] break-all md:table-cell`}>
                    {a.mailbox}
                  </td>
                  <td className={`${listClass.td} hidden lg:table-cell`}>
                    {a.note ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={listClass.td}>
                    <span className="flex items-center gap-2.5">
                      <AliasSwitch
                        row={a}
                        held={a.adminLocked && !canLift}
                        url={`${api}/${a.id}`}
                        onError={(m) => {
                          setNotice({ error: true, text: m });
                        }}
                      />
                      <StatusText tone={a.enabled && !a.locked ? "success" : "neutral"}>
                        {a.enabled ? "On" : "Off"}
                      </StatusText>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <ListEmpty>Nothing matches this search or filter.</ListEmpty>}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirming.length === 1 ? "Delete this alias?" : `Delete ${String(confirming.length)} aliases?`}
          confirmLabel={confirming.length === 1 ? "Delete alias" : "Delete aliases"}
          pendingLabel="Deleting…"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const err = await remove(confirm);
            if (err === null) setConfirm(null);
            return err;
          }}
        >
          <p>
            <span className="font-mono text-[14px] break-all">{confirming.map((r) => r.address).join(", ")}</span> stops
            receiving mail once the mail server is updated. Mail sent to {confirming.length === 1 ? "it" : "them"}{" "}
            afterwards is refused.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
