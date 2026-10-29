// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldCheck } from "lucide-react";
import { useId, useState } from "react";

import { PasswordInput } from "../password-input";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { authCall } from "./webauthn";

/**
 * "Confirm it's you" for a sensitive action the server refused with 403 `step_up_required`: the console password, or a
 * current authenticator code or a recovery code when the person has two-factor sign-in (the identity layer refuses the
 * password alone then; someone with only a passkey is told to sign in again with it). On success `onConfirmed` runs the
 * action again.
 */
export function StepUpForm({
  why,
  onConfirmed,
  onCancel,
}: {
  /** One sentence on why this action asks (shown under the heading). */
  why: string;
  onConfirmed: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    await onConfirmed();
  }

  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-confirm`}
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const pw = form.get("console-password");
        const code = form.get("code");
        if (typeof pw === "string" && pw !== "") void confirm({ password: pw });
        else if (typeof code === "string" && code.trim() !== "") void confirm({ code: code.trim() });
        else setError("Enter your password or a code.");
      }}
      className="flex w-full max-w-md flex-col gap-3 rounded-xl border bg-background p-4"
    >
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
      <PasswordInput id={`${id}-cpw`} name="console-password" autoComplete="current-password" className={inputClass} />
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
          {busy ? "Checking…" : "Confirm"}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
