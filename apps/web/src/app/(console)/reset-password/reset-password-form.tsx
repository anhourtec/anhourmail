// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { type SyntheticEvent, useState } from "react";

import { BREACHED_PASSWORD } from "@anhourmail/shared/security";

import { useHydrated } from "@/components/use-hydrated";

import { PasswordInput } from "@/components/password-input";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
const MIN_PASSWORD = 12;

export function ResetPasswordForm({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function submit(newPassword: string, confirm: string, removePasskeys: boolean) {
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Use at least ${String(MIN_PASSWORD)} characters for your password.`);
      return;
    }
    if (newPassword !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword, token, ...(removePasskeys ? { removePasskeys: true } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      if (res.ok) setDone(true);
      else if (res.status === 429) setError("Too many attempts. Wait a minute and try again.");
      else if (json?.code === "FACTOR_REQUIRED" && json.message) setError(json.message);
      else if (json?.code === BREACHED_PASSWORD.authCode) setError(BREACHED_PASSWORD.message);
      else setError("This reset link is invalid or has expired. Ask for a new one.");
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
    void submit(get("password"), get("confirm"), form.get("removePasskeys") === "on");
  }

  if (done) {
    return (
      <p role="status" className="am-body rounded-lg border bg-muted px-4 py-3">
        Your password has been changed.{" "}
        <Link href="/sign-in" className="font-medium underline underline-offset-2">
          Sign in
        </Link>{" "}
        with the new one.
      </p>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
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
      <label className="flex items-start gap-2.5">
        <input type="checkbox" name="removePasskeys" className="mt-1 size-4 accent-primary" />
        <span className="am-small text-foreground">
          Also remove all passkeys from my login (choose this if you think someone else got in). Every session is signed
          out either way.
        </span>
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
        {pending ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
