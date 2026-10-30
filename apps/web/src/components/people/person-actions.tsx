// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ACCOUNT_ROLES, type AccountRole, ROLE_LABELS } from "@anhourmail/shared/rbac";

import { callApi } from "../api";
import { ConfirmDialog, inlineActionClass } from "../console/flyout";
import { inputClass, secondaryButtonClass } from "../ui-classes";

/**
 * Change someone's role (Owners only; the server checks again). Making someone an Owner asks first: Owners can do
 * everything, including removing other Owners.
 */
export function RoleForm({
  accountId,
  userId,
  label,
  role,
}: {
  accountId: string;
  userId: string;
  /** Name or email, for labels and the confirmation. */
  label: string;
  role: AccountRole;
}) {
  const router = useRouter();
  const [next, setNext] = useState<AccountRole>(role);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOwner, setConfirmOwner] = useState(false);
  const url = `/api/accounts/${accountId}/people/${encodeURIComponent(userId)}`;

  async function save(): Promise<string | null> {
    setPending(true);
    setError(null);
    setSaved(false);
    const res = await callApi(url, { method: "PATCH", body: { role: next } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return res.message;
    }
    setSaved(true);
    router.refresh();
    return null;
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <label htmlFor={`role-${userId}`} className="am-h4">
        Role
        <span className="sr-only"> for {label}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <select
          id={`role-${userId}`}
          value={next}
          onChange={(e) => {
            setNext(e.target.value as AccountRole);
            setSaved(false);
          }}
          className={`${inputClass} sm:max-w-64`}
        >
          {ACCOUNT_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[`account:${r}`]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || next === role}
          onClick={() => {
            if (next === "owner") setConfirmOwner(true);
            else void save();
          }}
          className={secondaryButtonClass}
        >
          {pending ? "Saving…" : "Save role"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="am-small">
        {saved ? "Saved." : ""}
      </p>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {confirmOwner && (
        <ConfirmDialog
          title={`Make ${label} an owner?`}
          confirmLabel="Make owner"
          pendingLabel="Saving…"
          onCancel={() => {
            setConfirmOwner(false);
          }}
          onConfirm={async () => {
            const err = await save();
            if (err === null) setConfirmOwner(false);
            return err;
          }}
        >
          <p>Owners can do everything in this account, including removing you.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Remove someone from the account (two steps). Their mailboxes and mail stay, person-less with sign-in off. `closeHref`: where to go after (the
 * details panel closes, since the person is gone).
 */
export function RemovePerson({
  accountId,
  userId,
  label,
  closeHref,
}: {
  accountId: string;
  userId: string;
  label: string;
  closeHref: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={() => {
          setConfirming(true);
        }}
        className={inlineActionClass}
      >
        <UserMinus aria-hidden />
        Remove
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Remove ${label}?`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          onCancel={() => {
            setConfirming(false);
          }}
          onConfirm={async () => {
            const res = await callApi(`/api/accounts/${accountId}/people/${encodeURIComponent(userId)}`, {
              method: "DELETE",
            });
            if (!res.ok) return res.message;
            setConfirming(false);
            router.push(closeHref, { scroll: false });
            router.refresh();
            return null;
          }}
        >
          <p>
            They lose access to this account at once. Their mailboxes and mail stay, as shared addresses with their
            sign-in turned off.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
