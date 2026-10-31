// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { callApi } from "../api";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * The mailbox's sender name ("Name <address>") with "Edit name" for people who manage mailboxes (rule 61; core
 * `people/names.ts`). A person's mailbox uses their name unless a custom display name is set here ("Use the person's
 * name" clears it); a mailbox without a person has only its own. Saving queues the mail server update, and the webmail
 * renames the mailbox's sending identities on its next request.
 */
export function EditMailboxName({
  accountId,
  mailboxId,
  custom,
  senderName,
  personName,
  canEdit,
}: {
  accountId: string;
  mailboxId: string;
  /** The custom display name, or null when it follows the person (or has none). */
  custom: string | null;
  /** What it sends as now. */
  senderName: string | null;
  /** The person it belongs to, or null for a mailbox without one. */
  personName: string | null;
  canEdit: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [follow, setFollow] = useState(custom === null);
  const [value, setValue] = useState(custom ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPerson = personName !== null;

  async function save(e: SyntheticEvent) {
    e.preventDefault();
    if (hasPerson && !follow && value.trim() === "") {
      setError("Enter a display name, or use the person's name.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes/${mailboxId}/name`, {
      method: "PUT",
      body: { displayName: hasPerson && follow ? "" : value },
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
        <span data-testid="mailbox-sender-name">
          {senderName ?? <span className="text-muted-foreground">Not set</span>}
        </span>
        {hasPerson && (
          <span className="am-micro">
            {custom === null ? "The person's name" : "Custom, instead of the person's name"}
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setFollow(custom === null);
              setValue(custom ?? "");
              setError(null);
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
      {hasPerson ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Display name</legend>
          <label className="flex items-center gap-2 text-[14px]">
            <input
              type="radio"
              name={`${id}-source`}
              checked={follow}
              onChange={() => {
                setFollow(true);
                setError(null);
              }}
            />
            <span>
              Use the person&apos;s name
              {personName !== "" ? <span className="text-muted-foreground"> ({personName})</span> : null}
            </span>
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <input
              type="radio"
              name={`${id}-source`}
              checked={!follow}
              onChange={() => {
                setFollow(false);
              }}
            />
            <span>Custom name</span>
          </label>
        </fieldset>
      ) : (
        <label htmlFor={`${id}-name`} className="sr-only">
          Display name
        </label>
      )}
      {(!hasPerson || !follow) && (
        <input
          id={`${id}-name`}
          value={value}
          aria-label={hasPerson ? "Custom name" : undefined}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          maxLength={80}
          autoComplete="off"
          autoFocus
          className={inputClass}
        />
      )}
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
