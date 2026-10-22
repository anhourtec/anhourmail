// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  ArrowLeft,
  Cake,
  Check,
  Download,
  Ellipsis,
  FolderInput,
  Mail,
  PanelLeft,
  Pencil,
  Phone,
  Plus,
  Search,
  StickyNote,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type SyntheticEvent, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";

import type { ContactView } from "@/server/webmail/contacts";

import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { ConfirmDialog } from "./dialogs";
import type { ContactFields, ContactsData, MailClient } from "./mail-client";
import { RefusedError } from "./mail-client";
import { iconButtonClass, Menu, type MenuEntry } from "./menu";
import { SenderAvatar } from "./message-list";
import { useToasts } from "./toasts";

type Group = "all" | "mine" | "other" | `label:${string}`;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function initialsOf(name: string): string {
  const words = name.split(/[\s@._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

const letterOf = (name: string) => {
  const c = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
};

function birthdayText(b: NonNullable<ContactView["birthday"]>): string {
  return `${MONTHS[b.month - 1] ?? ""} ${String(b.day)}${b.year !== null ? `, ${String(b.year)}` : ""}`;
}

// ---- form ---------------------------------------------------------------------------------------------------

const EMAIL_LABELS = [
  ["", "Email"],
  ["home", "Home"],
  ["work", "Work"],
] as const;
const PHONE_LABELS = [
  ["mobile", "Mobile"],
  ["home", "Home"],
  ["work", "Work"],
  ["", "Phone"],
] as const;

function ContactForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: ContactView | null;
  onCancel: () => void;
  onSave: (fields: ContactFields) => Promise<void>;
}) {
  const [given, setGiven] = useState(initial?.given ?? (initial && !initial.surname ? initial.name : ""));
  const [surname, setSurname] = useState(initial?.surname ?? "");
  const [organization, setOrganization] = useState(initial?.organization ?? "");
  const [emails, setEmails] = useState(initial?.emails.length ? initial.emails : [{ address: "", label: "" }]);
  const [phones, setPhones] = useState(initial?.phones ?? []);
  const [month, setMonth] = useState(initial?.birthday?.month ?? 0);
  const [day, setDay] = useState(initial?.birthday?.day ?? 0);
  const [year, setYear] = useState(initial?.birthday?.year ? String(initial.birthday.year) : "");
  const [labels, setLabels] = useState(initial?.labels.join(", ") ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const y = year.trim() === "" ? null : Number(year);
    if (y !== null && (!Number.isInteger(y) || y < 1800 || y > 2200)) {
      setError("Enter a year like 1990, or leave it empty.");
      return;
    }
    const fields: ContactFields = {
      given: given.trim(),
      surname: surname.trim(),
      name: "",
      emails: emails.filter((x) => x.address.trim() !== "").map((x) => ({ address: x.address.trim(), label: x.label })),
      phones: phones.filter((x) => x.number.trim() !== "").map((x) => ({ number: x.number.trim(), label: x.label })),
      organization: organization.trim(),
      notes,
      birthday: month > 0 && day > 0 ? { year: y, month, day } : null,
      labels: labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    };
    if (!fields.given && !fields.surname && fields.emails.length === 0 && fields.phones.length === 0) {
      setError("Add a name, an email address or a phone number.");
      return;
    }
    setSaving(true);
    try {
      await onSave(fields);
    } catch (err) {
      setError(err instanceof RefusedError ? err.message : "The contact couldn't be saved.");
      setSaving(false);
    }
  };

  const field = "flex flex-col gap-1.5";
  return (
    <form
      method="post"
      onSubmit={(e) => {
        void submit(e);
      }}
      aria-label={initial ? "Edit contact" : "New contact"}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <button type="button" onClick={onCancel} aria-label="Cancel" className={iconButtonClass}>
          <X className="size-4" aria-hidden />
        </button>
        <h2 className="am-h3 flex-1">{initial ? "Edit contact" : "New contact"}</h2>
        <button type="submit" disabled={saving} className={`${primaryButtonClass} h-9`}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={field}>
            <span className="am-h4">First name</span>
            <input
              value={given}
              onChange={(e) => {
                setGiven(e.target.value);
              }}
              maxLength={100}
              autoFocus
              className={inputClass}
            />
          </label>
          <label className={field}>
            <span className="am-h4">Last name</span>
            <input
              value={surname}
              onChange={(e) => {
                setSurname(e.target.value);
              }}
              maxLength={100}
              className={inputClass}
            />
          </label>
        </div>
        <label className={field}>
          <span className="am-h4">Company</span>
          <input
            value={organization}
            onChange={(e) => {
              setOrganization(e.target.value);
            }}
            maxLength={200}
            className={inputClass}
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="am-h4 mb-1.5">Email</legend>
          {emails.map((x, i) => (
            <div key={String(i)} className="flex gap-2">
              <input
                type="email"
                aria-label={`Email ${String(i + 1)}`}
                value={x.address}
                onChange={(e) => {
                  setEmails((l) => l.map((v, j) => (j === i ? { ...v, address: e.target.value } : v)));
                }}
                maxLength={254}
                className={`${inputClass} font-mono text-[14px]`}
              />
              <select
                aria-label={`Email ${String(i + 1)} type`}
                value={x.label}
                onChange={(e) => {
                  setEmails((l) => l.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)));
                }}
                className="h-10 rounded-lg border bg-background px-2 text-[14px]"
              >
                {EMAIL_LABELS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove email ${String(i + 1)}`}
                onClick={() => {
                  setEmails((l) => l.filter((_, j) => j !== i));
                }}
                className={iconButtonClass}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          {emails.length < 10 && (
            <button
              type="button"
              onClick={() => {
                setEmails((l) => [...l, { address: "", label: "" }]);
              }}
              className="inline-flex w-fit items-center gap-1.5 text-[13px] text-primary"
            >
              <Plus className="size-3.5" aria-hidden /> Add email
            </button>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="am-h4 mb-1.5">Phone</legend>
          {phones.map((x, i) => (
            <div key={String(i)} className="flex gap-2">
              <input
                type="tel"
                aria-label={`Phone ${String(i + 1)}`}
                value={x.number}
                onChange={(e) => {
                  setPhones((l) => l.map((v, j) => (j === i ? { ...v, number: e.target.value } : v)));
                }}
                maxLength={40}
                className={`${inputClass} font-mono text-[14px]`}
              />
              <select
                aria-label={`Phone ${String(i + 1)} type`}
                value={x.label}
                onChange={(e) => {
                  setPhones((l) => l.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)));
                }}
                className="h-10 rounded-lg border bg-background px-2 text-[14px]"
              >
                {PHONE_LABELS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove phone ${String(i + 1)}`}
                onClick={() => {
                  setPhones((l) => l.filter((_, j) => j !== i));
                }}
                className={iconButtonClass}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          {phones.length < 10 && (
            <button
              type="button"
              onClick={() => {
                setPhones((l) => [...l, { number: "", label: "mobile" }]);
              }}
              className="inline-flex w-fit items-center gap-1.5 text-[13px] text-primary"
            >
              <Plus className="size-3.5" aria-hidden /> Add phone
            </button>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="am-h4 mb-1.5">Birthday</legend>
          <div className="flex gap-2">
            <select
              aria-label="Birthday month"
              value={month}
              onChange={(e) => {
                setMonth(Number(e.target.value));
              }}
              className="h-10 flex-1 rounded-lg border bg-background px-2 text-[14px]"
            >
              <option value={0}>Month</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              aria-label="Birthday day"
              value={day}
              onChange={(e) => {
                setDay(Number(e.target.value));
              }}
              className="h-10 w-24 rounded-lg border bg-background px-2 text-[14px]"
            >
              <option value={0}>Day</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={String(i)} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
            <input
              aria-label="Birthday year (optional)"
              inputMode="numeric"
              placeholder="Year"
              value={year}
              onChange={(e) => {
                setYear(e.target.value.replace(/\D/g, "").slice(0, 4));
              }}
              className={`${inputClass} w-24 font-mono text-[14px]`}
            />
          </div>
        </fieldset>
        <label className={field}>
          <span className="am-h4">Labels</span>
          <input
            value={labels}
            onChange={(e) => {
              setLabels(e.target.value);
            }}
            placeholder="family, book club"
            className={inputClass}
          />
          <span className="am-micro">Separate labels with commas.</span>
        </label>
        <label className={field}>
          <span className="am-h4">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
            maxLength={4000}
            rows={4}
            className="w-full rounded-lg border bg-background px-3 py-2 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

// ---- detail -------------------------------------------------------------------------------------------------

function Detail({
  contact,
  bookName,
  onBack,
  onEdit,
  onDelete,
  onMove,
  onCompose,
}: {
  contact: ContactView;
  bookName: string;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (to: "mine" | "other") => void;
  onCompose: (address: string, name: string) => void;
}) {
  const inOther = bookName === "Other contacts";
  const row = "flex items-start gap-3 py-2";
  return (
    <section aria-label={`Contact: ${contact.name}`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-2">
        <button type="button" onClick={onBack} aria-label="Back to contacts" className={`${iconButtonClass} md:hidden`}>
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="flex-1" />
        <button type="button" onClick={onEdit} aria-label="Edit contact" className={iconButtonClass}>
          <Pencil className="size-4" aria-hidden />
        </button>
        <Menu
          label="More for this contact"
          icon={Ellipsis}
          items={[
            inOther
              ? {
                  label: "Move to My contacts",
                  icon: FolderInput,
                  onSelect: () => {
                    onMove("mine");
                  },
                }
              : {
                  label: "Move to Other contacts",
                  icon: FolderInput,
                  onSelect: () => {
                    onMove("other");
                  },
                },
          ]}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete contact"
          className={`${iconButtonClass} text-destructive hover:text-destructive`}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="flex items-center gap-4">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-primary/12 font-medium text-[22px] text-primary">
            {initialsOf(contact.name)}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="am-h2 break-words">{contact.name || "No name"}</h2>
            {contact.organization && <p className="am-small">{contact.organization}</p>}
            <p className="am-micro">{bookName}</p>
          </div>
        </div>
        {contact.emails[0] && (
          <div>
            <button
              type="button"
              onClick={() => {
                onCompose(contact.emails[0]?.address ?? "", contact.name);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg border px-3.5 text-[13.5px] hover:bg-accent"
            >
              <Mail className="size-4" aria-hidden /> Send email
            </button>
          </div>
        )}
        <div className="flex flex-col divide-y rounded-xl border px-4">
          {contact.emails.map((e) => (
            <div key={e.address} className={row}>
              <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-col">
                <button
                  type="button"
                  onClick={() => {
                    onCompose(e.address, contact.name);
                  }}
                  className="truncate text-left font-mono text-[13.5px] text-primary hover:underline"
                >
                  {e.address}
                </button>
                <span className="am-micro capitalize">{e.label || "email"}</span>
              </div>
            </div>
          ))}
          {contact.phones.map((p) => (
            <div key={p.number} className={row}>
              <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex flex-col">
                <a href={`tel:${p.number.replace(/[^\d+]/g, "")}`} className="font-mono text-[13.5px] hover:underline">
                  {p.number}
                </a>
                <span className="am-micro capitalize">{p.label || "phone"}</span>
              </div>
            </div>
          ))}
          {contact.birthday && (
            <div className={row}>
              <Cake className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex flex-col">
                <span className="text-[13.5px]">{birthdayText(contact.birthday)}</span>
                <span className="am-micro">Birthday</span>
              </div>
            </div>
          )}
          {contact.labels.length > 0 && (
            <div className={row}>
              <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex flex-wrap gap-1.5">
                {contact.labels.map((l) => (
                  <span key={l} className="rounded-md bg-accent px-2 py-0.5 text-[12.5px]">
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}
          {contact.notes && (
            <div className={row}>
              <StickyNote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="whitespace-pre-wrap break-words text-[13.5px]">{contact.notes}</p>
            </div>
          )}
          {contact.emails.length + contact.phones.length === 0 && !contact.birthday && !contact.notes && (
            <p className="am-small py-3">No details yet. Choose Edit to add some.</p>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- the view -----------------------------------------------------------------------------------------------

/**
 * Contacts: an A–Z list with search, groups (My contacts, Other contacts, labels) and multi-select on
 * one side, the selected contact (or the form) on the other; one pane at a time on phones. Everything is stored in
 * the mailbox's own address books (JMAP Contacts) through the BFF, so it also syncs to phones over CardDAV.
 */
export function ContactsView({
  client,
  data,
  onChanged,
  onCompose,
  onToggleSidebar,
}: {
  client: MailClient;
  data: ContactsData | null;
  onChanged: () => Promise<void>;
  onCompose: (address: string, name: string) => void;
  onToggleSidebar: () => void;
}) {
  const toasts = useToasts();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Group>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const books = data?.books ?? [];
  // The account these contacts belong to; every change carries it (the BFF refuses another active mailbox).
  const account = data?.accountId ?? "";
  const otherId = books.find((b) => b.isOther)?.id;
  const bookName = (c: ContactView) => (otherId && c.bookIds.includes(otherId) ? "Other contacts" : "My contacts");
  const labels = [...new Set((data?.contacts ?? []).flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));

  const q = query.trim().toLowerCase();
  const visible = (data?.contacts ?? []).filter((c) => {
    if (group === "mine" && otherId && c.bookIds.includes(otherId)) return false;
    if (group === "other" && !(otherId && c.bookIds.includes(otherId))) return false;
    if (group.startsWith("label:") && !c.labels.includes(group.slice(6))) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.organization.toLowerCase().includes(q) ||
      c.emails.some((e) => e.address.includes(q)) ||
      c.phones.some((p) => p.number.replace(/\D/g, "").includes(q.replace(/\D/g, "") || "\u0000"))
    );
  });

  const byLetter = new Map<string, ContactView[]>();
  for (const c of visible) {
    const l = letterOf(c.name);
    byLetter.set(l, [...(byLetter.get(l) ?? []), c]);
  }
  const sections = [...byLetter.entries()].sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));

  const selected = data?.contacts.find((c) => c.id === selectedId) ?? null;
  const detailOpen = mode !== "view" || selected !== null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await onChanged();
      toasts.show({ message: done });
    } catch (err) {
      toasts.show({
        message: err instanceof RefusedError ? err.message : "That didn't work. Try again.",
        tone: "error",
      });
    }
  };

  const toggle = (id: string) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const menu: MenuEntry[] = [
    { label: "Import contacts (.vcf)", icon: Upload, onSelect: () => file.current?.click() },
    {
      label: "Export all contacts",
      icon: Download,
      onSelect: () => {
        window.location.assign(client.exportContactsUrl());
      },
    },
    { separator: true },
    {
      label: "Automatically save people I email",
      checked: data?.autoSave ?? true,
      onSelect: () => {
        const next = !(data?.autoSave ?? true);
        void run(
          () => client.setAutoSave(account, next),
          next ? "People you email will be saved." : "Automatic saving is off.",
        );
      },
    },
  ];

  const groupChip = (g: Group, label: string, count?: number) => (
    <button
      key={g}
      type="button"
      aria-pressed={group === g}
      onClick={() => {
        setGroup(g);
        setChecked(new Set());
      }}
      className={`h-7 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors ${
        group === g
          ? "border-primary bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1 font-mono text-[11px]">{count}</span>}
    </button>
  );
  const otherCount = otherId ? (data?.contacts ?? []).filter((c) => c.bookIds.includes(otherId)).length : 0;
  const ids = [...checked];

  return (
    <div className="grid min-h-0 min-w-0 grid-cols-1 md:grid-cols-[23rem_minmax(0,1fr)] lg:grid-cols-[26rem_minmax(0,1fr)]">
      <section
        aria-label="Contacts"
        className={`flex min-h-0 flex-col border-r ${detailOpen ? "hidden md:flex" : "flex"}`}
      >
        <header className="flex h-14 shrink-0 items-center gap-1 px-2">
          <button type="button" onClick={onToggleSidebar} aria-label="Toggle folders" className={iconButtonClass}>
            <PanelLeft className="size-4" aria-hidden />
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <h1 className="min-w-0 flex-1 truncate font-display font-medium text-[1.25rem] tracking-tight">Contacts</h1>
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setMode("new");
            }}
            aria-label="New contact"
            className={iconButtonClass}
          >
            <UserPlus className="size-4" aria-hidden />
          </button>
          <Menu label="Contacts options" icon={Ellipsis} items={menu} />
          <input
            ref={file}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > 1024 * 1024) {
                toasts.show({ message: "Contact files can be up to 1 MB.", tone: "error" });
                return;
              }
              void (async () => {
                try {
                  const r = await client.importContacts(account, f);
                  await onChanged();
                  toasts.show({
                    message: `Imported ${String(r.imported)} contact${r.imported === 1 ? "" : "s"}${r.skipped ? ` (${String(r.skipped)} skipped)` : ""}.${r.full ? " A mailbox can keep up to 5,000 contacts." : ""}`,
                  });
                } catch (err) {
                  toasts.show({
                    message: err instanceof RefusedError ? err.message : "That file couldn't be imported.",
                    tone: "error",
                  });
                }
              })();
            }}
          />
        </header>
        {checked.size > 0 ? (
          <div
            role="toolbar"
            aria-label="Selected contacts"
            className="mx-2 mb-2 flex h-10 shrink-0 items-center gap-0.5 rounded-lg border bg-accent/60 px-1.5"
          >
            <button
              type="button"
              onClick={() => {
                setChecked(new Set());
              }}
              aria-label="Clear selection"
              className={iconButtonClass}
            >
              <X className="size-4" aria-hidden />
            </button>
            <span className="flex-1 px-1 font-medium text-[13px]">{checked.size} selected</span>
            <Menu
              label="Move selected"
              icon={FolderInput}
              items={[
                {
                  label: "Move to My contacts",
                  onSelect: () => void run(() => client.moveContacts(account, ids, "mine"), "Moved to My contacts."),
                },
                {
                  label: "Move to Other contacts",
                  onSelect: () =>
                    void run(() => client.moveContacts(account, ids, "other"), "Moved to Other contacts."),
                },
              ]}
            />
            <button
              type="button"
              onClick={() => {
                window.location.assign(client.exportContactsUrl(ids));
              }}
              aria-label="Export selected"
              className={iconButtonClass}
            >
              <Download className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm({ ids });
              }}
              aria-label="Delete selected"
              className={`${iconButtonClass} text-destructive hover:text-destructive`}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <label className="relative mx-2 mb-2 flex shrink-0 items-center">
            <span className="sr-only">Search contacts</span>
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search contacts…"
              aria-label="Search contacts"
              className="h-8 w-full rounded-lg border bg-background pr-3 pl-8 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        )}
        {data?.truncated && (
          <p role="status" className="am-micro mx-3 mb-2">
            Showing the first 5,000 contacts. A contacts app synced to this mailbox shows the rest.
          </p>
        )}
        <div role="group" aria-label="Contact groups" className="flex shrink-0 gap-1.5 overflow-x-auto px-2 pb-2">
          {groupChip("all", "All", data?.contacts.length)}
          {groupChip("mine", "My contacts")}
          {groupChip("other", "Other contacts", otherCount)}
          {labels.map((l) => groupChip(`label:${l}`, l))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t">
          {data === null ? (
            <div className="flex flex-col gap-1 p-3">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={String(i)} className="flex h-14 items-center gap-3 px-1">
                  <Bone className="size-9 rounded-md" />
                  <div className="flex flex-col gap-1.5">
                    <Bone className="h-3.5 w-36" />
                    <Bone className="h-3 w-48" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Users className="size-5" aria-hidden />
              </span>
              <p className="am-h4">
                {query ? "No contacts match" : group === "other" ? "No other contacts yet" : "No contacts yet"}
              </p>
              <p className="am-small max-w-64">
                {group === "other"
                  ? "People you email are saved here automatically."
                  : "Add people with New contact, import a .vcf file, or just email them."}
              </p>
            </div>
          ) : (
            <ul aria-label="Contact list" className="pb-4">
              {sections.map(([letter, list]) => (
                <li key={letter}>
                  <p className="sticky top-0 z-10 bg-background/95 px-4 pt-3 pb-1 font-medium text-[12px] text-muted-foreground backdrop-blur">
                    {letter}
                  </p>
                  <ul>
                    {list.map((c) => {
                      const isChecked = checked.has(c.id);
                      return (
                        <li key={c.id}>
                          <div
                            className={`group flex h-14 cursor-pointer items-center gap-3 px-3 transition-colors ${
                              isChecked ? "bg-primary/8" : c.id === selectedId ? "bg-accent" : "hover:bg-accent/50"
                            }`}
                          >
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isChecked}
                              aria-label={`Select ${c.name}`}
                              onClick={() => {
                                toggle(c.id);
                              }}
                              className="relative size-9 shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className={isChecked || checked.size > 0 ? "hidden" : "group-hover:hidden"}>
                                <SenderAvatar email={c.emails[0]?.address} label={initialsOf(c.name)} />
                              </span>
                              <span
                                aria-hidden
                                className={`absolute inset-0 items-center justify-center ${isChecked || checked.size > 0 ? "flex" : "hidden group-hover:flex"}`}
                              >
                                <span
                                  className={`flex size-5 items-center justify-center rounded-[5px] border-2 ${
                                    isChecked
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-muted-foreground/70 bg-background"
                                  }`}
                                >
                                  {isChecked && <Check className="size-3.5" strokeWidth={3.5} />}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (checked.size > 0) {
                                  toggle(c.id);
                                  return;
                                }
                                setSelectedId(c.id);
                                setMode("view");
                              }}
                              className="flex min-w-0 flex-1 flex-col text-left"
                            >
                              <span className="truncate text-[14px]">{c.name || "No name"}</span>
                              <span className="truncate font-mono text-[12px] text-muted-foreground">
                                {[c.emails[0]?.address, c.phones[0]?.number, c.organization].find(
                                  (v) => v && v !== c.name,
                                ) ?? ""}
                              </span>
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <main className={`min-h-0 ${detailOpen ? "flex flex-col" : "hidden md:flex md:flex-col"}`}>
        {mode === "new" || (mode === "edit" && selected) ? (
          <ContactForm
            key={mode === "new" ? "new" : (selected?.id ?? "")}
            initial={mode === "edit" ? selected : null}
            onCancel={() => {
              setMode("view");
            }}
            onSave={async (fields) => {
              if (mode === "edit" && selected) {
                await client.updateContact(account, selected.id, fields);
                await onChanged();
                toasts.show({ message: "Contact saved." });
              } else {
                const { id } = await client.createContact(account, fields);
                await onChanged();
                setSelectedId(id);
                toasts.show({ message: "Contact added." });
              }
              setMode("view");
            }}
          />
        ) : selected ? (
          <Detail
            contact={selected}
            bookName={bookName(selected)}
            onBack={() => {
              setSelectedId(null);
            }}
            onEdit={() => {
              setMode("edit");
            }}
            onDelete={() => {
              setConfirm({ ids: [selected.id] });
            }}
            onMove={(to) =>
              void run(
                () => client.moveContacts(account, [selected.id], to),
                to === "mine" ? "Moved to My contacts." : "Moved to Other contacts.",
              )
            }
            onCompose={onCompose}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Users className="size-6" aria-hidden />
            </span>
            <p className="am-h3">No contact selected</p>
            <p className="am-small max-w-72">Pick someone to see their details, or add a new contact.</p>
            <button
              type="button"
              onClick={() => {
                setMode("new");
              }}
              className={`${secondaryButtonClass} mt-1 h-9`}
            >
              <UserPlus className="size-4" aria-hidden /> New contact
            </button>
          </div>
        )}
      </main>

      {confirm && (
        <ConfirmDialog
          title={confirm.ids.length === 1 ? "Delete this contact?" : `Delete ${String(confirm.ids.length)} contacts?`}
          body="They're removed from your address books on every device. This can't be undone."
          confirm="Delete"
          onConfirm={() => {
            const del = confirm.ids;
            void run(
              async () => {
                await client.deleteContacts(account, del);
                setChecked(new Set());
                if (selectedId && del.includes(selectedId)) setSelectedId(null);
              },
              del.length === 1 ? "Contact deleted." : `${String(del.length)} contacts deleted.`,
            );
          }}
          onClose={() => {
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
