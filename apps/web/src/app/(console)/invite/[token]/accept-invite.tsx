// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { PasswordInput } from "@/components/password-input";
import { inputClass, primaryButtonClass } from "@/components/ui-classes";
import { useHydrated } from "@/components/use-hydrated";

const MIN_PASSWORD = 12;

/**
 * Accepts an invite. `join`: the person is signed in as the invited address. `create`: they have no login yet, so
 * this makes one for the invited address (names + password), then signs them in. The token travels in the body.
 */
export function AcceptInvite({
  token,
  mode,
  accountName,
}: {
  token: string;
  mode: "join" | "create";
  accountName: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, string>): Promise<{ email?: string } | null> {
    const res = await fetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: { email?: string };
      error?: { message?: string };
    } | null;
    if (res.ok) return json?.data ?? {};
    setError(
      res.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : (json?.error?.message ?? "Something went wrong. Try again."),
    );
    return null;
  }

  async function submit(body: Record<string, string>) {
    setPending(true);
    setError(null);
    try {
      const out = await post(body);
      if (!out) return;
      if (mode === "create" && out.email) {
        // The login exists now: sign in with it, as the sign-in page would.
        const res = await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: out.email, password: body.password }),
        });
        if (!res.ok) {
          router.replace("/sign-in");
          return;
        }
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (mode === "join") {
    return (
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={pending || !hydrated}
          onClick={() => void submit({})}
          className={`${primaryButtonClass} w-full`}
        >
          {pending ? "Joining…" : `Join ${accountName}`}
        </button>
      </div>
    );
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    const password = get("password");
    if (get("firstName").trim() === "") {
      setError("Enter your first name.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${String(MIN_PASSWORD)} characters for your password.`);
      return;
    }
    if (password !== get("confirm")) {
      setError("The two passwords don't match.");
      return;
    }
    void submit({ firstName: get("firstName"), lastName: get("lastName"), password });
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <p className="am-small">Create your console login to join. You&apos;ll use it to sign in here.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">First name</span>
          <input name="firstName" autoComplete="given-name" maxLength={60} required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">
            Last name <span className="am-micro font-normal">(optional)</span>
          </span>
          <input name="lastName" autoComplete="family-name" maxLength={60} className={inputClass} />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Password</span>
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
        <span className="am-h4">Confirm password</span>
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
      <button type="submit" disabled={pending || !hydrated} className={`${primaryButtonClass} w-full`}>
        {pending ? "Joining…" : `Create login and join`}
      </button>
    </form>
  );
}
