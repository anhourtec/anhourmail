// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Ban, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { SUSPENSION_REASONS } from "@anhourmail/shared/platform";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

const NOTE_MAX = 1000;

/**
 * Staff (Global Administrator, `platform.account.suspend`): suspend a customer account or a person, or lift it. The
 * panel asks for a reason category (shown to the customer) and an optional internal note (staff only), then a fresh
 * confirmation that it's you when the server asks (403 `step_up_required`). The server emails the customer.
 */
export function SuspensionControl({
  kind,
  url,
  suspended,
  subject,
}: {
  kind: "account" | "person";
  /** `/api/platform/accounts/:id/suspension` or `/api/platform/people/:id/suspension`. */
  url: string;
  suspended: boolean;
  /** What is being suspended, for the panel's wording (account name or the person's email). */
  subject: string;
}) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = kind === "account" ? "account" : "person";

  function close() {
    setOpen(false);
    setStepUp(false);
    setError(null);
    setReason("");
    setNote("");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = suspended
      ? await callApi(url, { method: "DELETE" })
      : await callApi(url, { method: "POST", body: { reason, ...(note.trim() !== "" ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    close();
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={suspended ? secondaryButtonClass : dangerButtonClass}
      >
        {suspended ? <RotateCcw className="size-4" aria-hidden /> : <Ban className="size-4" aria-hidden />}
        {suspended ? "Lift suspension" : `Suspend ${noun}`}
      </button>
    );
  }

  if (stepUp) {
    return (
      <StepUpForm
        why="Suspensions change who can sign in, so they need your console password."
        onConfirmed={async () => {
          setStepUp(false);
          await submit();
        }}
        onCancel={close}
      />
    );
  }

  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex w-full max-w-lg flex-col gap-4 rounded-xl border p-4"
      noValidate
    >
      <h4 id={`${id}-title`} className="am-h4">
        {suspended ? `Lift the suspension of this ${noun}` : `Suspend this ${noun}`}
      </h4>
      <p className="am-small max-w-prose">
        {suspended ? (
          <>
            <span className="break-all">{subject}</span> can be used again: mailboxes this suspension stopped resume
            within a minute or two. The customer is emailed.
          </>
        ) : kind === "account" ? (
          <>
            Every mailbox in <span className="break-all">{subject}</span> stops signing in, sending and receiving (mail
            is kept), and its people see only a suspension notice in the console. Its Owners and administrators are
            emailed the reason and how to appeal.
          </>
        ) : (
          <>
            <span className="break-all">{subject}</span> is signed out everywhere and can&apos;t sign in to the console;
            the mailboxes assigned to them are suspended (mail is kept). They are emailed the reason and how to appeal.
          </>
        )}
      </p>
      {!suspended && (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-reason`} className="am-h4">
              Reason
            </label>
            <select
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              className={inputClass}
              required
            >
              <option value="">Choose a reason…</option>
              {Object.entries(SUSPENSION_REASONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="am-micro">The customer sees this in plain words.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-note`} className="am-h4">
              Internal note <span className="am-small font-normal">(optional)</span>
            </label>
            <textarea
              id={`${id}-note`}
              value={note}
              maxLength={NOTE_MAX}
              rows={3}
              onChange={(e) => {
                setNote(e.target.value);
              }}
              className={`${inputClass} h-auto py-2`}
            />
            <p className="am-micro">Staff only: never shown to the customer or put in emails.</p>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || (!suspended && reason === "")}
          className={suspended ? primaryButtonClass : dangerButtonClass}
        >
          {busy ? "Working…" : suspended ? "Lift suspension" : `Suspend ${noun}`}
        </button>
        <button type="button" onClick={close} className={secondaryButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
