// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AtSign, Globe, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { senderEntry } from "@anhourmail/shared/senders";

import { callApi } from "../api";
import { ConfirmDialog, inlineActionClass } from "../console/flyout";
import { StatusText } from "../console/status-text";
import { inputClass, primaryButtonClass } from "../ui-classes";

export type AccountSafeSenderRow = {
  id: string;
  entry: string;
  kind: "address" | "domain";
  /** Formatted on the server ("5 Nov 2026"). */
  added: string;
};

/** Typed text split into entries: one per line, or separated by commas, semicolons or spaces. */
export const splitEntries = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * The account-wide Safe senders list (ADR-0032 §1): an add form (one or more addresses or domains) for those who may
 * change it, and the entries with Remove. The server checks every entry and the limits again.
 */
export function AccountSafeSenders({
  accountId,
  rows,
  canManage,
  maxEntries,
}: {
  accountId: string;
  rows: AccountSafeSenderRow[];
  canManage: boolean;
  maxEntries: number;
}) {
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AccountSafeSenderRow | null>(null);
  const base = `/api/accounts/${encodeURIComponent(accountId)}/safe-senders`;
  const full = rows.length >= maxEntries;

  async function add() {
    const entries = splitEntries(text);
    if (entries.length === 0) {
      setError("Type an address (jane@example.com) or a domain (example.com).");
      return;
    }
    // The same check the server makes, so a typo is answered here.
    const wrong = entries.find((e) => senderEntry(e) === null);
    if (wrong !== undefined) {
      setError(`"${wrong.slice(0, 60)}" isn't an address or a domain (jane@example.com, example.com).`);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    const res = await callApi(base, { method: "POST", body: { entries } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const added = (res.data as { added: number }).added;
    setText("");
    setNotice(
      added === 0
        ? "Already on the list."
        : `Added ${String(added)} ${added === 1 ? "entry" : "entries"}. Every mailbox follows within a minute.`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label htmlFor={`${id}-entry`} className="text-[14px] font-medium">
            Address or domain
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`${id}-entry`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              placeholder="partner.example or jane@partner.example"
              autoComplete="off"
              spellCheck={false}
              disabled={full}
              aria-describedby={`${id}-hint`}
              className={`${inputClass} font-mono sm:max-w-md`}
            />
            <button type="submit" disabled={pending || full} className={`${primaryButtonClass} w-fit`}>
              <Plus className="size-4" aria-hidden />
              {pending ? "Adding…" : "Add"}
            </button>
          </div>
          <p id={`${id}-hint`} className="am-micro">
            {full
              ? `The list is full (${String(maxEntries)} entries). Remove some to add more.`
              : "Separate several with commas. A domain covers that domain exactly, not its subdomains."}
          </p>
          {error && <StatusText tone="danger">{error}</StatusText>}
          {notice && <StatusText tone="success">{notice}</StatusText>}
        </form>
      )}
      {rows.length === 0 ? (
        <p className="am-small border-t py-4">No safe senders yet.</p>
      ) : (
        <ul aria-label="Account safe senders" className="border-t">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-2 border-b px-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                {r.kind === "domain" ? (
                  <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <AtSign className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[14px]">{r.entry}</span>
                  <span className="am-micro">
                    {r.kind === "domain" ? "Domain" : "Address"}
                    {" · added "}
                    <span className="am-num">{r.added}</span>
                  </span>
                </div>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(r);
                  }}
                  className={`${inlineActionClass} shrink-0`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Remove<span className="sr-only"> {r.entry}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.entry}?`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const res = await callApi(`${base}/${encodeURIComponent(confirm.id)}`, { method: "DELETE" });
            if (!res.ok) return res.message;
            setConfirm(null);
            setNotice(null);
            router.refresh();
            return null;
          }}
        >
          Images from this sender stop loading by themselves, and the trusted-only Junk rule applies to them again.
          People who added them to their own Safe senders keep them.
        </ConfirmDialog>
      )}
    </div>
  );
}
