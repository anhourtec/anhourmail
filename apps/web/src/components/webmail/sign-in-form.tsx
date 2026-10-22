// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type SyntheticEvent, useState } from "react";

import { useHydrated } from "@/components/use-hydrated";

import { PasswordInput } from "@/components/password-input";
import { inputClass, primaryButtonClass } from "@/components/ui-classes";

const MESSAGES: Record<number, string> = {
  400: "Enter your mailbox address and password.",
  401: "Mailbox address or password is wrong.",
  429: "Too many attempts. Wait a few minutes and try again.",
  503: "The mail server isn't answering. Try again in a moment.",
};

/** Posts the mailbox address and password to the BFF once; on success the session cookie is already set. */
export function WebmailSignInForm({ home, defaultAddress }: { home: string; defaultAddress: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/webmail/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: form.get("address"), password: form.get("password") }),
      });
      if (res.ok) {
        window.location.assign(home);
        return;
      }
      const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      setError(
        code === "mailbox_unavailable"
          ? "This mailbox can't be used right now. If you think this is a mistake, ask your account's admin."
          : (MESSAGES[res.status] ?? "Something went wrong. Try again."),
      );
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <form
      method="post"
      onSubmit={(e) => {
        void onSubmit(e);
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Mailbox address</span>
        <input
          name="address"
          type="email"
          autoComplete="username"
          placeholder="you@anhourmail.com"
          defaultValue={defaultAddress}
          autoFocus={defaultAddress === ""}
          required
          className={`${inputClass} font-mono text-[14px]`}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="webmail-password" className="am-h4">
          Password
        </label>
        <PasswordInput
          id="webmail-password"
          name="password"
          autoComplete="current-password"
          placeholder="Mailbox password"
          autoFocus={defaultAddress !== ""}
          required
          className={inputClass}
        />
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending || !hydrated} className={primaryButtonClass}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
