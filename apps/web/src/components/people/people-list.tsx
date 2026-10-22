// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { BookOpen, Info, RefreshCw, Send, ShieldCheck, Trash2, UserMinus, UserPlus } from "lucide-react";
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
import { StatusText } from "../console/status-text";

export type PersonRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  active: boolean;
  isYou: boolean;
  joined: string;
  joinedAt: number;
  canChangeRole: boolean;
  canRemove: boolean;
};

export type InviteRow = {
  id: string;
  email: string;
  roleLabel: string;
  expired: boolean;
  until: string;
  canManage: boolean;
};

const SORT_KEYS = {
  name: (r: PersonRow) => r.name || r.email,
  role: (r: PersonRow) => r.roleLabel,
  status: (r: PersonRow) => (r.active ? 0 : 1),
  joined: (r: PersonRow) => r.joinedAt,
};

const bulkAction =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] transition-colors hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:text-primary";

type Confirm = { kind: "remove"; ids: string[] } | { kind: "revoke"; id: string };

/**
 * People and roles (console page template): "Invite someone", search, role chips; the people list with a checkbox
 * column for those the viewer may remove, a ⋮ menu (details, role, remove) and names that open the person's panel
 * (`?person=`); then pending invites with resend and revoke. Every action is checked again by the server.
 */
export function PeopleList({
  accountId,
  people,
  invites,
  openId,
  inviteHref,
  docsHref,
}: {
  accountId: string;
  people: PersonRow[];
  invites: InviteRow[];
  openId: string | null;
  inviteHref: string | null;
  docsHref: string;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const base = `/accounts/${accountId}/people`;
  const api = `/api/accounts/${accountId}`;

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      people.filter(
        (p) =>
          (role === "all" || p.role === role) && (q === "" || p.name.toLowerCase().includes(q) || p.email.includes(q)),
      ),
    [people, role, q],
  );
  const { sorted, sort, toggle } = useSort(visible, SORT_KEYS, { key: "name", dir: "asc" });
  const removable = useMemo(() => sorted.filter((p) => p.canRemove).map((p) => p.userId), [sorted]);
  const selection = useSelection(removable);
  const shownInvites = invites.filter((i) => q === "" || i.email.includes(q));

  const roles = [...new Map(people.map((p) => [p.role, p.roleLabel])).entries()];
  const chips: ChipOption<string>[] = [
    { value: "all", label: "All", count: people.length },
    ...roles.map(([value, label]) => ({ value, label, count: people.filter((p) => p.role === value).length })),
  ];

  async function resend(id: string) {
    setNotice(null);
    const res = await callApi(`${api}/invites/${id}/resend`, { method: "POST" });
    if (!res.ok) {
      setNotice({ error: true, text: res.message });
      return;
    }
    const sent = (res.data as { emailSent?: unknown } | undefined)?.emailSent === true;
    setNotice({ error: false, text: sent ? "Sent again." : "Saved, but the email couldn't be sent." });
    router.refresh();
  }

  const label = (id: string) => people.find((p) => p.userId === id)?.email ?? "this person";

  return (
    <>
      <CommandBar
        label="People actions"
        end={
          <>
            <ListSearch label="Search people" value={query} onChange={setQuery} placeholder="Search this list" />
            <OverflowMenu
              items={[
                { label: "What each role can do", href: "#roles", icon: <ShieldCheck />, external: true },
                { label: "People and roles guide", href: docsHref, icon: <BookOpen />, external: true },
              ]}
            />
          </>
        }
      >
        {inviteHref && (
          <CommandLink href={inviteHref} icon={<UserPlus />}>
            Invite someone
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

      {roles.length > 1 && <FilterChips label="Role" options={chips} value={role} onChange={setRole} />}

      {notice && (
        <p role={notice.error ? "alert" : "status"} className={`am-small ${notice.error ? "text-destructive" : ""}`}>
          {notice.text}
        </p>
      )}

      <BulkBar count={selection.selected.length} onClear={selection.clear}>
        <button
          type="button"
          onClick={() => {
            setConfirm({ kind: "remove", ids: selection.selected });
          }}
          className={bulkAction}
        >
          <UserMinus aria-hidden />
          Remove…
        </button>
      </BulkBar>

      <section aria-labelledby="people" className="flex flex-col gap-2">
        <h2 id="people" className="sr-only">
          People
        </h2>
        <div className={listClass.wrap}>
          <table className={listClass.table}>
            <thead>
              <tr>
                {removable.length > 0 && (
                  <th scope="col" className={`${listClass.th} ${listClass.check}`}>
                    <Checkbox
                      label="Select everyone you can remove"
                      checked={selection.all}
                      indeterminate={selection.some}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <SortHeader label="Name" column="name" sort={sort} onSort={toggle} />
                <SortHeader label="Role" column="role" sort={sort} onSort={toggle} />
                <SortHeader
                  label="Status"
                  column="status"
                  sort={sort}
                  onSort={toggle}
                  className="hidden sm:table-cell"
                />
                <SortHeader
                  label="Joined"
                  column="joined"
                  sort={sort}
                  onSort={toggle}
                  className="hidden lg:table-cell"
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const open = `${base}?person=${encodeURIComponent(p.userId)}`;
                return (
                  <tr
                    key={p.userId}
                    data-open={p.userId === openId}
                    data-selected={selection.selected.includes(p.userId)}
                    className={listClass.row}
                  >
                    {removable.length > 0 && (
                      <td className={`${listClass.td} ${listClass.check}`}>
                        <Checkbox
                          label={`Select ${p.email}`}
                          checked={selection.selected.includes(p.userId)}
                          disabled={!p.canRemove}
                          onChange={(on) => {
                            selection.toggle(p.userId, on);
                          }}
                        />
                      </td>
                    )}
                    <td className={listClass.td}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <span className="flex flex-wrap items-center gap-2">
                            <Link
                              href={open}
                              scroll={false}
                              className="font-medium text-[14px] underline-offset-2 hover:underline"
                            >
                              {p.name || p.email}
                            </Link>
                            {p.isYou && <span className="am-status am-status--info">You</span>}
                          </span>
                          <span className="font-mono text-[12.5px] break-all text-muted-foreground">{p.email}</span>
                        </div>
                        <RowMenu
                          label={`Actions for ${p.email}`}
                          items={[
                            { label: "Open details", href: open, icon: <Info /> },
                            ...(p.canChangeRole
                              ? [{ label: "Change role", href: `${open}&tab=role`, icon: <ShieldCheck /> }]
                              : []),
                            ...(p.canRemove
                              ? [
                                  {
                                    label: "Remove…",
                                    icon: <UserMinus />,
                                    danger: true,
                                    onSelect: () => {
                                      setConfirm({ kind: "remove", ids: [p.userId] });
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </div>
                    </td>
                    <td className={listClass.td}>{p.roleLabel}</td>
                    <td className={`${listClass.td} hidden sm:table-cell`}>
                      <StatusText tone={p.active ? "success" : "neutral"}>
                        {p.active ? "Active" : "Suspended"}
                      </StatusText>
                    </td>
                    <td className={`${listClass.td} am-num hidden lg:table-cell`}>{p.joined}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length === 0 && <ListEmpty>Nothing matches this search or filter.</ListEmpty>}
        </div>
      </section>

      <section aria-labelledby="invites" className="mt-4 flex flex-col gap-2">
        <h2 id="invites" className="am-h3">
          Pending invites
        </h2>
        {shownInvites.length === 0 ? (
          <ListEmpty>No pending invites.</ListEmpty>
        ) : (
          <div className={listClass.wrap}>
            <table className={listClass.table}>
              <thead>
                <tr>
                  <th scope="col" className={listClass.th}>
                    Email
                  </th>
                  <th scope="col" className={`${listClass.th} hidden sm:table-cell`}>
                    Role
                  </th>
                  <th scope="col" className={listClass.th}>
                    Status
                  </th>
                  <th scope="col" className={`${listClass.th} hidden md:table-cell`}>
                    Link works until
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownInvites.map((i) => (
                  <tr key={i.id} className={listClass.row}>
                    <td className={listClass.td}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <span
                            className={`font-mono font-medium text-[14px] break-all ${i.expired ? "text-muted-foreground" : ""}`}
                          >
                            {i.email}
                          </span>
                          <span className="am-micro sm:hidden">{i.roleLabel}</span>
                        </div>
                        <RowMenu
                          label={`Actions for the invite to ${i.email}`}
                          items={
                            i.canManage
                              ? [
                                  { label: "Resend invite", icon: <Send />, onSelect: () => void resend(i.id) },
                                  {
                                    label: "Revoke invite…",
                                    icon: <Trash2 />,
                                    danger: true,
                                    onSelect: () => {
                                      setConfirm({ kind: "revoke", id: i.id });
                                    },
                                  },
                                ]
                              : []
                          }
                        />
                      </div>
                    </td>
                    <td className={`${listClass.td} hidden sm:table-cell`}>{i.roleLabel}</td>
                    <td className={listClass.td}>
                      <StatusText tone={i.expired ? "warning" : "info"}>{i.expired ? "Expired" : "Pending"}</StatusText>
                    </td>
                    <td className={`${listClass.td} am-num hidden md:table-cell`}>{i.until}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm?.kind === "remove" && (
        <ConfirmDialog
          title={
            confirm.ids.length === 1
              ? `Remove ${label(confirm.ids[0] ?? "")}?`
              : `Remove ${String(confirm.ids.length)} people?`
          }
          confirmLabel="Remove"
          pendingLabel="Removing…"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const r = await runBulk(confirm.ids, (id) => ({
              url: `${api}/people/${encodeURIComponent(id)}`,
              method: "DELETE",
            }));
            selection.clear();
            router.refresh();
            if (confirm.ids.length === 1 && r.failed[0]) return r.failed[0];
            if (confirm.ids.length > 1) {
              setNotice({ error: r.failed.length > 0, text: bulkMessage(r, "Removed", "person", "people") });
            }
            setConfirm(null);
            return null;
          }}
        >
          <p>
            {confirm.ids.length === 1 ? "They lose" : "They each lose"} access to this account at once. Their mailboxes
            and mail stay.
          </p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "revoke" && (
        <ConfirmDialog
          title="Revoke this invite?"
          confirmLabel="Revoke invite"
          pendingLabel="Revoking…"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const res = await callApi(`${api}/invites/${confirm.id}`, { method: "DELETE" });
            if (!res.ok) return res.message;
            setConfirm(null);
            router.refresh();
            return null;
          }}
        >
          <p>
            The link sent to{" "}
            <span className="font-mono text-[14px] break-all">
              {invites.find((i) => i.id === confirm.id)?.email ?? "this address"}
            </span>{" "}
            stops working straight away.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
