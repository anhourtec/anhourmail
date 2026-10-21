// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type SyntheticEvent, useState } from "react";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Always shows the same confirmation, whether or not the address has an account (no enumeration).
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(email: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }),
      });
      if (res.status === 429) setError("Too many attempts. Wait a minute and try again.");
      else setSent(true);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get("email");
    void submit(typeof value === "string" ? value.trim() : "");
  }

  if (sent) {
    return (
      <p role="status" className="am-body rounded-lg border bg-muted px-4 py-3">
        If an account uses that address, a reset link is on its way. Check your inbox (and spam) — the link works for
        one hour.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
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
        disabled={pending}
        className="h-10 rounded-lg bg-primary font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
