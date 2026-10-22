// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { useHydrated } from "@/components/use-hydrated";

import { PasswordInput } from "@/components/password-input";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Posts to the auth endpoint directly; the SDK stays server-side in packages/adapters (ADR-0008). `next` is where to
 * go afterwards — the page passes only paths it has checked (an invite link), never an arbitrary URL.
 */
export function SignInForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (res.ok) {
        router.replace(next);
        router.refresh();
        return;
      }
      setError(res.status === 429 ? "Too many attempts. Wait a minute and try again." : "Email or password is wrong.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="sign-in-password" className="am-h4">
            Password
          </label>
          <Link href="/forgot-password" className="am-small underline-offset-2 hover:text-foreground hover:underline">
            Forgot password?
          </Link>
        </div>
        <PasswordInput
          id="sign-in-password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          required
          className={inputClass}
        />
      </div>
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
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
