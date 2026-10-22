// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { APP_PASSWORD_PROTOCOL_LABELS, type AppPasswordProtocol } from "@anhourmail/shared/security";

import { callApi } from "../api";
import { ConfirmDialog, inlineActionClass } from "../console/flyout";
import { StatusText } from "../console/status-text";
import { secondaryButtonClass } from "../ui-classes";

export type AppPasswordRow = {
  id: string;
  name: string;
  protocols: AppPasswordProtocol[];
  revoking: boolean;
  /** Formatted on the server ("22 Oct 2026"). */
  created: string;
};

/** "Read mail (IMAP), Send mail (SMTP)" → "IMAP, SMTP": the short form for a list row. */
const SHORT: Record<AppPasswordProtocol, string> = {
  imap: "IMAP",
  pop3: "POP3",
  smtp: "SMTP",
  jmap: "JMAP",
  dav: "Contacts and calendars",
};

/**
 * A mailbox's app passwords: name, what each can be used for, when it was made, and Revoke (one, or all of them).
 * Revoking is quick but not instant: the row says "Revoking" until the mail server has dropped it.
 */
export function AppPasswordList({
  accountId,
  mailboxId,
  address,
  rows,
  canRevoke,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  rows: AppPasswordRow[];
  canRevoke: boolean;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<AppPasswordRow | "all" | null>(null);
  const base = `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/app-passwords`;
  const active = rows.filter((r) => !r.revoking);

  if (rows.length === 0) {
    return <p className="am-small border-t py-4">No app passwords yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={`App passwords for ${address}`} className="border-t">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-2 border-b px-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 items-center gap-3">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[14px] font-medium">{r.name}</span>
                <span className="am-micro">
                  <span title={r.protocols.map((p) => APP_PASSWORD_PROTOCOL_LABELS[p].label).join(", ")}>
                    {r.protocols.map((p) => SHORT[p]).join(", ")}
                  </span>
                  {" · created "}
                  <span className="am-num">{r.created}</span>
                </span>
              </div>
            </div>
            {r.revoking ? (
              <StatusText tone="neutral">Revoking</StatusText>
            ) : (
              canRevoke && (
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(r);
                  }}
                  className={`${inlineActionClass} shrink-0`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Revoke<span className="sr-only"> {r.name}</span>
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {canRevoke && active.length > 1 && (
        <button
          type="button"
          onClick={() => {
            setConfirm("all");
          }}
          className={`${secondaryButtonClass} w-fit`}
        >
          Revoke all app passwords
        </button>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm === "all" ? `Revoke all app passwords for ${address}?` : `Revoke ${confirm.name}?`}
          confirmLabel={confirm === "all" ? "Revoke all" : "Revoke app password"}
          pendingLabel="Revoking…"
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const res = await callApi(confirm === "all" ? base : `${base}/${encodeURIComponent(confirm.id)}`, {
              method: "DELETE",
            });
            if (!res.ok) return res.message;
            setConfirm(null);
            router.refresh();
            return null;
          }}
        >
          {confirm === "all"
            ? "Every mail app signed in with one of them stops working within a minute. The mailbox and its mail aren't affected."
            : "Apps using it stop signing in within a minute. Nothing else changes, and you can make a new one at any time."}
        </ConfirmDialog>
      )}
    </div>
  );
}
