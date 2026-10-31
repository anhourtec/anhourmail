// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { primaryButtonClass } from "../ui-classes";
import { MailboxPasswordField } from "./mailbox-password-field";

/**
 * Set a new password on a mailbox (`mailbox.password.reset`): the new password (typed or generated), then a recent
 * confirmation that it's you if the server asks, then a note that it applies within a minute. The person the mailbox
 * belongs to is emailed by the server; webmail sessions of the mailbox end, app passwords keep working.
 */
export function ResetMailboxPassword({
  accountId,
  mailboxId,
  address,
  ownerEmail,
  pending: applying,
  applyFailed,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  ownerEmail: string | null;
  /** A password set a moment ago is still being applied. */
  pending: boolean;
  /** The last password set here never reached the mail server (the old one still works): set it again. */
  applyFailed: boolean;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const url = `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/password`;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await callApi(url, { method: "POST", body: { password } });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    setStepUp(false);
    setPassword("");
    setDone(true);
    router.refresh();
  }

  if (stepUp) {
    return (
      <StepUpForm
        why="A mailbox password opens its mail, so setting one needs your console password."
        confirmLabel="Confirm and save"
        onConfirmed={async () => {
          setStepUp(false);
          await save();
        }}
        onCancel={() => {
          setStepUp(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <form
      onSubmit={(e: SyntheticEvent) => {
        e.preventDefault();
        void save();
      }}
      className="flex max-w-lg flex-col gap-4"
      noValidate
    >
      {/* Tells password managers which account the new password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={address} readOnly hidden />
      <p className="am-body max-w-prose">
        Set a new password for <span className="font-mono">{address}</span>, for example when its person forgot theirs.
        Its webmail sessions sign out; app passwords for mail apps keep working.
        {ownerEmail ? (
          <>
            {" "}
            We email <span className="break-all">{ownerEmail}</span> that it changed (never the password).
          </>
        ) : null}
      </p>
      {applyFailed && !done && (
        <p role="alert" className="am-small rounded-lg border border-destructive/40 px-3 py-2.5 text-destructive">
          The new password wasn&apos;t applied to the mail server, so the previous password still works. Set it again.
        </p>
      )}
      {(applying || done) && (
        <p role="status" className="am-small rounded-lg border bg-muted/40 px-3 py-2.5">
          {done ? "New password set. " : "A new password is being applied. "}
          It takes effect on the mail server within a minute.
        </p>
      )}
      <MailboxPasswordField value={password} onChange={setPassword} label="New password" />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || password === ""} className={`${primaryButtonClass} w-fit`}>
        <KeyRound className="size-4" aria-hidden />
        {busy ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
