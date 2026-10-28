// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound } from "lucide-react";
import { type SyntheticEvent, useId, useState } from "react";

import { generateMailboxPassword, MAILBOX_PASSWORD, MAILBOX_PASSWORD_RULES } from "@anhourmail/shared/security";

import { PasswordInput } from "@/components/password-input";

import { createMailClient, RefusedError } from "./mail-client";

const fieldClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The webmail's first-sign-in step ("Add a user" with "Require password change at first sign-in"): shown instead of
 * the inbox until the person replaces the password their administrator set. It uses the same change path as Settings →
 * Account → Password (current password checked by the mail server, the new one hashed by the control plane and applied
 * by the worker). The requirement ends only once the worker has applied the new password; until then the webmail API
 * refuses everything but this change and sign-out. If the last change gave up, the step says so.
 */
export function FirstPasswordStep({
  address,
  account,
  signInHref,
  lastFailed = false,
}: {
  address: string;
  /** The JMAP account of this session (the server refuses a change for another mailbox). */
  account: string;
  signInHref: string;
  /** The last password change for this mailbox didn't reach the mail server. */
  lastFailed?: boolean;
}) {
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"signed_in" | "sign_in_again" | null>(null);

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await createMailClient().changePassword(account, current, next);
      if (out.applied && out.signedIn) {
        setDone("signed_in");
        window.location.reload();
      } else {
        setDone("sign_in_again");
      }
    } catch (err) {
      setError(err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl border bg-card p-6 sm:p-8">
        <div className="flex flex-col gap-2">
          <h1 className="am-h2">Choose your own password</h1>
          <p className="am-small">
            Your administrator set the password for <span className="font-mono">{address}</span>. Choose a new one that
            only you know to open your mail. Mail apps and app passwords aren&apos;t affected.
          </p>
        </div>
        {lastFailed && done === null && (
          <p role="alert" className="am-small rounded-lg border border-destructive/40 px-3 py-2 text-destructive">
            Your last password change didn&apos;t go through, so the password you were given still works. Choose a new
            one again.
          </p>
        )}
        {done === "sign_in_again" ? (
          <p role="status" className="am-body rounded-lg border bg-muted px-4 py-3">
            Your new password is being applied. In a minute,{" "}
            <a href={signInHref} className="font-medium underline underline-offset-2">
              sign in again
            </a>{" "}
            with it. If it doesn&apos;t work yet, sign in with the password you were given.
          </p>
        ) : (
          <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3" noValidate>
            <input type="text" name="username" autoComplete="username" value={address} readOnly hidden />
            <label htmlFor={`${id}-cur`} className="am-h4">
              Password you were given
            </label>
            <PasswordInput
              id={`${id}-cur`}
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
              }}
              autoComplete="current-password"
              className={fieldClass}
            />
            <label htmlFor={`${id}-new`} className="am-h4">
              New password
            </label>
            <PasswordInput
              id={`${id}-new`}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setGenerated(null);
              }}
              autoComplete="new-password"
              maxLength={MAILBOX_PASSWORD.max}
              aria-describedby={`${id}-rules`}
              spellCheck={false}
              className={fieldClass}
            />
            <div className="flex">
              <button
                type="button"
                onClick={() => {
                  const p = generateMailboxPassword();
                  setNext(p);
                  setConfirm(p);
                  setGenerated(p);
                }}
                className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors hover:bg-accent"
              >
                <KeyRound className="size-4" aria-hidden /> Generate a strong password
              </button>
            </div>
            {generated !== null && generated === next && (
              <p role="status" className="am-small rounded-lg border bg-accent px-3 py-2 text-foreground">
                Your new password: <code className="font-mono break-all">{generated}</code>. Save it in your password
                manager now; it isn&apos;t shown again.
              </p>
            )}
            <label htmlFor={`${id}-confirm`} className="am-h4">
              Confirm new password
            </label>
            <PasswordInput
              id={`${id}-confirm`}
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
              autoComplete="new-password"
              maxLength={MAILBOX_PASSWORD.max}
              spellCheck={false}
              className={fieldClass}
            />
            <ul id={`${id}-rules`} className="am-micro flex list-disc flex-col gap-0.5 pl-4">
              {MAILBOX_PASSWORD_RULES.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="am-small text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || done !== null || current === "" || next === ""}
              className="h-10 rounded-lg bg-primary font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60"
            >
              {busy || done === "signed_in" ? "Saving…" : "Save and open my mail"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
