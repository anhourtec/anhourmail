// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { RefreshCw, Trash2, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ACCOUNT_ROLES, type AccountRole, ROLE_LABELS } from "@anhourmail/shared/rbac";

import { callApi } from "../api";

const small =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors disabled:opacity-60";
const danger = `${small} border-destructive/40 text-destructive hover:bg-destructive/10`;
const quiet = `${small} hover:bg-accent`;
const selectClass =
  "h-8 rounded-lg border bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** One API call; refreshes the page on success and keeps the error message otherwise. */
function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(url: string, init: Parameters<typeof callApi>[1]): Promise<unknown> {
    setPending(true);
    setError(null);
    const res = await callApi(url, init);
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return null;
    }
    router.refresh();
    return res.data ?? true;
  }
  return { pending, error, setError, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="am-micro max-w-xs text-right text-destructive">
      {error}
    </p>
  ) : null;
}

/**
 * Role change (Owners) and a two-step remove (no browser dialogs). Making someone an Owner asks first: Owners can
 * do everything, including removing other Owners.
 */
export function MemberActions({
  accountId,
  userId,
  label,
  role,
  canChangeRole,
  canRemove,
}: {
  accountId: string;
  userId: string;
  /** Name or email, for button labels and the confirmation. */
  label: string;
  role: AccountRole;
  canChangeRole: boolean;
  canRemove: boolean;
}) {
  const { pending, error, run } = useAction();
  const [next, setNext] = useState<AccountRole>(role);
  const [confirm, setConfirm] = useState<"owner" | "remove" | null>(null);
  const url = `/api/accounts/${accountId}/people/${encodeURIComponent(userId)}`;

  const save = async () => {
    if (await run(url, { method: "PATCH", body: { role: next } })) setConfirm(null);
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirm === "owner" ? (
        <div className="flex max-w-xs flex-col items-end gap-2 text-right">
          <p className="am-micro">Make {label} an owner? Owners can do everything here, including removing you.</p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => void save()} className={danger}>
              {pending ? "Saving…" : "Make owner"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
              }}
              className={quiet}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : confirm === "remove" ? (
        <div className="flex max-w-xs flex-col items-end gap-2 text-right">
          <p className="am-micro">
            Remove {label}? They lose access to this account at once. Their mailboxes and mail stay.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(url, { method: "DELETE" }).then((done) => {
                  if (done) setConfirm(null);
                })
              }
              className={danger}
            >
              {pending ? "Removing…" : "Remove"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
              }}
              className={quiet}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canChangeRole && (
            <>
              <label className="sr-only" htmlFor={`role-${userId}`}>
                Role for {label}
              </label>
              <select
                id={`role-${userId}`}
                value={next}
                onChange={(e) => {
                  setNext(e.target.value as AccountRole);
                }}
                className={selectClass}
              >
                {ACCOUNT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[`account:${r}`]}
                  </option>
                ))}
              </select>
              {next !== role && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (next === "owner") setConfirm("owner");
                    else void save();
                  }}
                  className={quiet}
                >
                  {pending ? "Saving…" : "Save role"}
                </button>
              )}
            </>
          )}
          {canRemove && (
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => {
                setConfirm("remove");
              }}
              className={`${small} text-muted-foreground hover:bg-accent hover:text-foreground`}
            >
              <UserMinus className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** Resend (new link, fresh period) and a two-step revoke for a pending invite. */
export function InviteActions({ accountId, inviteId, email }: { accountId: string; inviteId: string; email: string }) {
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const base = `/api/accounts/${accountId}/invites/${inviteId}`;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(base, { method: "DELETE" }).then((done) => {
                  if (done) setConfirming(false);
                })
              }
              className={danger}
            >
              {pending ? "Revoking…" : "Revoke"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className={quiet}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={pending}
              aria-label={`Resend the invite to ${email}`}
              onClick={() =>
                void run(`${base}/resend`, { method: "POST" }).then((data) => {
                  if (!data) return;
                  const emailSent = (data as { emailSent?: unknown }).emailSent === true;
                  setSent(emailSent ? "Sent again." : "Saved, but the email couldn't be sent.");
                })
              }
              className={quiet}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Resend
            </button>
            <button
              type="button"
              aria-label={`Revoke the invite to ${email}`}
              onClick={() => {
                setSent(null);
                setConfirming(true);
              }}
              className={`${small} text-muted-foreground hover:bg-accent hover:text-foreground`}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>
      {sent && (
        <p role="status" className="am-micro">
          {sent}
        </p>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
