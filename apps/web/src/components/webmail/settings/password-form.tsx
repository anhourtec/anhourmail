// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound } from "lucide-react";
import { type SyntheticEvent, useId, useState } from "react";

import { generateMailboxPassword, MAILBOX_PASSWORD, MAILBOX_PASSWORD_RULES } from "@anhourmail/shared/security";

import { PasswordInput } from "@/components/password-input";

import { type MailClient, RefusedError } from "../mail-client";
import { fieldClass, Group, smallPrimary, smallSecondary } from "./controls";

type Status = { tone: "ok" | "error"; text: string } | null;

/**
 * "Change password" in the webmail's Account settings: the current password (checked by the mail server) and a new
 * one (typed or generated here, shown once). This session stays signed in; every other webmail session of the mailbox
 * ends. App passwords keep working.
 */
export function ChangePasswordForm({
  client,
  address,
  account,
}: {
  client: MailClient;
  address: string;
  /** The JMAP account the page shows (the server refuses a change for another active mailbox). */
  account: string;
}) {
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const out = await client.changePassword(account, current, next);
      setCurrent("");
      setNext("");
      setGenerated(null);
      setStatus({
        tone: "ok",
        text: !out.applied
          ? "Password change saved. It takes effect within a minute; then sign in with the new password."
          : out.signedIn
            ? "Password changed. Other devices signed in to the webmail are signed out."
            : "Password changed. Sign in again with the new password.",
      });
    } catch (err) {
      setStatus({
        tone: "error",
        text: err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="Password" description="The password you sign in to the webmail with. Mail apps use app passwords.">
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3 px-4 py-3" noValidate>
        {/* Tells password managers which account the new password belongs to. */}
        <input type="text" name="username" autoComplete="username" value={address} readOnly hidden />
        <label htmlFor={`${id}-cur`} className="text-[13px] text-muted-foreground">
          Current password
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
        <label htmlFor={`${id}-new`} className="text-[13px] text-muted-foreground">
          New password
        </label>
        {/* Full width on its own row (readable next to password-manager icons); the generator on the row below. */}
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
              setGenerated(p);
            }}
            className={smallSecondary}
          >
            <KeyRound className="size-4" aria-hidden /> Generate a strong password
          </button>
        </div>
        {generated !== null && generated === next && (
          <p role="status" className="am-small rounded-lg border bg-accent px-3 py-2 text-foreground">
            Your new password: <code className="font-mono break-all">{generated}</code>. Save it in your password
            manager before you change it; it isn&apos;t shown again.
          </p>
        )}
        <ul id={`${id}-rules`} className="am-micro flex list-disc flex-col gap-0.5 pl-4">
          {MAILBOX_PASSWORD_RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy || current === "" || next === ""} className={smallPrimary}>
            {busy ? "Changing…" : "Change password"}
          </button>
          <span
            aria-live="polite"
            className={`am-small ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {status?.text ?? ""}
          </span>
        </div>
      </form>
    </Group>
  );
}
