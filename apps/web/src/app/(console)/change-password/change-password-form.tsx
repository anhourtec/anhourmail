// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { BREACHED_PASSWORD } from "@anhourmail/shared/security";

import { PasswordInput } from "@/components/password-input";
import { useHydrated } from "@/components/use-hydrated";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
const MIN_PASSWORD = 12;

/** Current (the one the admin gave them) and new password, through the identity layer's change-password endpoint. */
export function ChangePasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function submit(currentPassword: string, newPassword: string, confirm: string) {
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Use at least ${String(MIN_PASSWORD)} characters for your password.`);
      return;
    }
    if (newPassword !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a password different from the one you were given.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
      });
      const json = (await res.json().catch(() => null)) as { code?: string } | null;
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      if (res.status === 429) setError("Too many attempts. Wait a minute and try again.");
      else if (json?.code === BREACHED_PASSWORD.authCode) setError(BREACHED_PASSWORD.message);
      else if (json?.code === "INVALID_PASSWORD") setError("The password you were given isn't right.");
      else setError("That didn't work. Check both passwords and try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    void submit(get("current"), get("password"), get("confirm"));
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Password you were given</span>
        <PasswordInput name="current" autoComplete="current-password" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">New password</span>
        <PasswordInput
          name="password"
          autoComplete="new-password"
          placeholder="At least 12 characters"
          required
          minLength={MIN_PASSWORD}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Confirm new password</span>
        <PasswordInput
          name="confirm"
          autoComplete="new-password"
          placeholder="Type it again"
          required
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || !hydrated}
        className="h-10 rounded-lg bg-primary font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save and continue"}
      </button>
    </form>
  );
}
