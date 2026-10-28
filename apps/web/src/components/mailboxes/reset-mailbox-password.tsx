// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { callApi } from "../api";
import { PasswordInput } from "../password-input";
import { authCall } from "../security/webauthn";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
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
  const id = useId();
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

  async function confirm(secret: { password: string } | { code: string }) {
    setBusy(true);
    setError(null);
    const res = await authCall("/step-up", { method: "POST", body: secret });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 429 || res.code === "STEP_UP_NEEDS_FACTOR" || res.code === "STEP_UP_SESSION_ENDED"
          ? res.message
          : "That isn't right. Try your password or a current code again.",
      );
      return;
    }
    await save();
  }

  if (stepUp) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const pw = form.get("console-password");
          const code = form.get("code");
          if (typeof pw === "string" && pw !== "") void confirm({ password: pw });
          else if (typeof code === "string" && code.trim() !== "") void confirm({ code: code.trim() });
          else setError("Enter your password or a code.");
        }}
        className="flex max-w-md flex-col gap-3 rounded-xl border p-4"
      >
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex flex-col gap-1">
            <h4 className="am-h4">Confirm it&apos;s you</h4>
            <p className="am-small">
              A mailbox password opens its mail, so setting one needs your console password or a code from the last few
              minutes.
            </p>
          </div>
        </div>
        <label htmlFor={`${id}-cpw`} className="am-h4">
          Console password
        </label>
        <PasswordInput
          id={`${id}-cpw`}
          name="console-password"
          autoComplete="current-password"
          className={inputClass}
        />
        <label htmlFor={`${id}-code`} className="am-small">
          Or a code from your authenticator app, or a recovery code
        </label>
        <input id={`${id}-code`} name="code" autoComplete="one-time-code" className={`${inputClass} font-mono`} />
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            {busy ? "Checking…" : "Confirm and save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStepUp(false);
              setError(null);
            }}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        </div>
      </form>
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
