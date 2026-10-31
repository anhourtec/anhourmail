// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldCheck } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";

import { PasswordInput } from "../password-input";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { authCall } from "./webauthn";

/**
 * "Confirm it's you" for a sensitive action the server refused with 403 `step_up_required`: the console password,
 * whatever the person signed in with and whatever second factors they have (ADR-0028). A confirmation counts for a
 * few minutes. On success `onConfirmed` runs the action again.
 *
 * `nested` renders it without its own `<form>`, for a place that already sits inside one (Enter still confirms).
 */
export function StepUpForm({
  why,
  onConfirmed,
  onCancel,
  confirmLabel = "Confirm",
  nested = false,
}: {
  /** One sentence on why this action asks (shown under the heading). */
  why: string;
  onConfirmed: () => Promise<void> | void;
  onCancel: () => void;
  /** The button's words ("Confirm and save"). */
  confirmLabel?: string;
  nested?: boolean;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (password === "") {
      setError("Enter your console password.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await authCall("/step-up", { method: "POST", body: { password } });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 429 || res.code === "STEP_UP_SESSION_ENDED" || res.code === "ACCOUNT_TEMPORARILY_LOCKED"
          ? res.message
          : "That password isn't right. Try again.",
      );
      return;
    }
    setPassword("");
    await onConfirmed();
  }

  const body = (
    <>
      <div className="flex gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="flex flex-col gap-1">
          <h4 id={`${id}-confirm`} className="am-h4">
            Confirm it&apos;s you
          </h4>
          <p className="am-small">{why}</p>
        </div>
      </div>
      <label htmlFor={`${id}-cpw`} className="am-h4">
        Console password
      </label>
      <PasswordInput
        id={`${id}-cpw`}
        name="console-password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
        {...(nested
          ? {
              onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void confirm();
                }
              },
            }
          : {})}
        className={inputClass}
      />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type={nested ? "button" : "submit"}
          disabled={busy}
          {...(nested ? { onClick: () => void confirm() } : {})}
          className={primaryButtonClass}
        >
          {busy ? "Checking…" : confirmLabel}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          Cancel
        </button>
      </div>
    </>
  );

  const frame = "flex w-full max-w-md flex-col gap-3 rounded-xl border bg-background p-4";
  if (nested) {
    return (
      <div role="group" aria-labelledby={`${id}-confirm`} className={frame}>
        {body}
      </div>
    );
  }
  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-confirm`}
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
      className={frame}
    >
      {body}
    </form>
  );
}
