// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { callApi } from "../api";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * The mailbox's display name (the sender name in "Name <address>") with "Edit name" for people who manage mailboxes.
 * Saving applies it to the mail server for new sending identities; the person can still change their own sender name in
 * the webmail's settings.
 */
export function EditMailboxName({
  accountId,
  mailboxId,
  name,
  canEdit,
}: {
  accountId: string;
  mailboxId: string;
  name: string | null;
  canEdit: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: SyntheticEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes/${mailboxId}/name`, {
      method: "PUT",
      body: { displayName: value },
    });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <span>{name ?? <span className="text-muted-foreground">Not set</span>}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setValue(name ?? "");
              setEditing(true);
            }}
            className="text-[14px] text-primary underline-offset-2 hover:underline"
          >
            Edit name
          </button>
        )}
      </span>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2" noValidate>
      <label htmlFor={`${id}-name`} className="sr-only">
        Display name
      </label>
      <input
        id={`${id}-name`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        maxLength={80}
        autoComplete="off"
        autoFocus
        className={inputClass}
      />
      {error && (
        <span role="alert" className="am-micro text-destructive">
          {error}
        </span>
      )}
      <span className="flex gap-2">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
      </span>
    </form>
  );
}
