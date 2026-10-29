// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { callApi } from "../api";
import { StatusText } from "../console/status-text";
import { StepUpForm } from "../security/step-up-form";
import { dangerButtonClass, inputClass, secondaryButtonClass } from "../ui-classes";

/**
 * "Delete account" for Owners (ADR-0025): what happens, then the account's name typed exactly, a step-up if the server
 * asks, then the request. While a deletion is pending it shows the date and, for Owners, "Cancel deletion".
 */
export function DeleteAccount({
  accountId,
  accountName,
  graceDays,
  pending,
}: {
  accountId: string;
  accountName: string;
  graceDays: number;
  pending: { deleteAfter: string; canCancel: boolean; started: boolean } | null;
}) {
  const id = useId();
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const endpoint = `/api/accounts/${encodeURIComponent(accountId)}/deletion`;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await callApi(endpoint, { method: "POST", body: { confirmName: typed } });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    router.refresh();
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    const res = await callApi(endpoint, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) setError(res.message);
    else router.refresh();
  }

  if (pending) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="flex flex-col gap-1">
            <h3 className="am-h4">
              {pending.started ? "This account is being deleted" : "This account is scheduled for deletion"}
            </h3>
            <p className="am-small text-foreground">
              {pending.started
                ? "The grace period has ended: its mailboxes, mail, aliases and domains are being removed. This can't be stopped now."
                : "Its mailboxes are suspended and everything in it will be removed for good on the date below, unless an Owner cancels."}
            </p>
            <p className="am-small">
              Deletion date: <span className="font-mono text-foreground">{pending.deleteAfter}</span>
            </p>
          </div>
        </div>
        {pending.canCancel && (
          <div>
            <button type="button" onClick={() => void cancel()} disabled={busy} className={secondaryButtonClass}>
              Cancel deletion
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ul className="am-small flex list-disc flex-col gap-1.5 pl-5 text-foreground">
        <li>Every mailbox in the account is suspended straight away: nobody can sign in, send or receive.</li>
        <li>
          After {String(graceDays)} days the account, all its mailboxes and their mail, its aliases and its domains are
          removed for good. Until then an Owner can cancel and everything comes back.
        </li>
        <li>
          Export first: once the mailboxes are suspended, their mail can&apos;t be exported. Each person exports their
          own mail and contacts from the webmail (Settings, Export).
        </li>
        <li>
          People keep their console logins and any other accounts. The audit log is kept as our retention policy says.
        </li>
      </ul>
      <label htmlFor={`${id}-name`} className="am-h4">
        Type <span className="font-mono">{accountName}</span> to confirm
      </label>
      <input
        id={`${id}-name`}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
        }}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} max-w-md`}
      />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {stepUp && (
        <StepUpForm
          why="Deleting an account removes everyone's mail after the grace period, so we check it's you."
          onConfirmed={async () => {
            setStepUp(false);
            await submit();
          }}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      )}
      <div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || typed.trim() !== accountName.trim()}
          className={dangerButtonClass}
        >
          Delete this account
        </button>
      </div>
      <p className="am-micro">
        <StatusText tone="warning">
          Everyone in the account is emailed when you ask, and again if you cancel.
        </StatusText>
      </p>
    </div>
  );
}
