// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { nameProblem } from "@anhourmail/shared/names";

import { callApi } from "../api";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * A person's name with "Edit name" for whoever may edit their profile (the person; an admin for a Member; an Owner for
 * anyone). It is the one source (rule 61): the console shows it, and it is the sender name of every mailbox of theirs
 * without a custom display name, so saving also changes what their mail is sent as. `url` is their profile endpoint
 * (`/api/me/profile` or the People route), which takes `{ name }` alone without touching the other details.
 */
export function EditPersonName({ url, name, canEdit }: { url: string; name: string; canEdit: boolean }) {
  const id = useId();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: SyntheticEvent) {
    e.preventDefault();
    const v = value.trim();
    const problem = v === "" ? "Enter your name." : v.length > 80 ? "Use at most 80 characters." : nameProblem(v);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const res = await callApi(url, { method: "PUT", body: { name: v } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setEditing(false);
    setSaved(true);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="am-small">Name</span>
        <span className="am-body" data-testid="person-name">
          {name}
        </span>
        {saved && (
          <p role="status" className="am-small">
            Name saved.
          </p>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setValue(name);
              setError(null);
              setSaved(false);
              setEditing(true);
            }}
            className={`${secondaryButtonClass} w-fit`}
          >
            <Pencil className="size-4" aria-hidden />
            Edit name
          </button>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="flex max-w-md flex-col gap-2" noValidate>
      <label htmlFor={`${id}-name`} className="am-small">
        Name
      </label>
      <input
        id={`${id}-name`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        maxLength={80}
        autoComplete="name"
        autoFocus
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-err` : undefined}
        className={inputClass}
      />
      {error && (
        <span id={`${id}-err`} role="alert" className="am-small text-destructive">
          {error}
        </span>
      )}
      <span className="flex gap-2">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Saving…" : "Save name"}
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
