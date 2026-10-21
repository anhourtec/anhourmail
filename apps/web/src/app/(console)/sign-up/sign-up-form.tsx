// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { PasswordInput } from "@/components/password-input";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

const MIN_PASSWORD = 12;

/**
 * Sign-up: first name (required), last name (optional), display name (pre-filled from first + last and kept in
 * sync until edited; clearing it goes back to automatic). Posts to the auth endpoint; the SDK stays server-side
 * (ADR-0008) and the server re-validates and applies the same display-name default.
 */
/** `invite`: a valid invite — the email is fixed to the invited address and the token is sent with the sign-up. */
export function SignUpForm({ invite }: { invite?: { token: string; email: string } }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [displayEdited, setDisplayEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const autoDisplay = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
  const shownDisplay = displayEdited ? displayName : autoDisplay;

  async function submit(form: FormData) {
    const emailValue = form.get("email");
    const email = invite ? invite.email : typeof emailValue === "string" ? emailValue.trim() : "";
    const passwordValue = form.get("password");
    const password = typeof passwordValue === "string" ? passwordValue : "";
    if (firstName.trim() === "") {
      setError("Enter your first name.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${String(MIN_PASSWORD)} characters for your password.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          name: shownDisplay.trim(),
          email,
          password,
          ...(invite ? { inviteToken: invite.token } : {}),
        }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      if (res.status === 429) setError("Too many attempts. Wait a minute and try again.");
      else if (res.status === 403) setError("This invite is no longer valid. Ask for a new one.");
      else if (res.status === 422 || res.status === 400) {
        setError("We couldn't create that account. Check your details, or sign in if you already have one.");
      } else setError("Something went wrong. Try again in a moment.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit(new FormData(e.currentTarget));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">First name</span>
          <input
            name="firstName"
            autoComplete="given-name"
            placeholder="Alex"
            required
            maxLength={60}
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
            }}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">
            Last name <span className="am-micro font-normal">(optional)</span>
          </span>
          <input
            name="lastName"
            autoComplete="family-name"
            placeholder="Rivera"
            maxLength={60}
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
            }}
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sign-up-display-name" className="am-h4">
          Display name
        </label>
        <input
          id="sign-up-display-name"
          name="displayName"
          autoComplete="nickname"
          maxLength={80}
          value={shownDisplay}
          placeholder="Alex Rivera"
          aria-describedby="sign-up-display-name-hint"
          onChange={(e) => {
            const v = e.target.value;
            setDisplayEdited(v !== "");
            setDisplayName(v);
          }}
          className={inputClass}
        />
        <span id="sign-up-display-name-hint" className="am-micro">
          How your name appears to others. You can change it later.
        </span>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">Email</span>
        {invite && <span className="am-micro">Your invite is for this address.</span>}
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          {...(invite ? { value: invite.email, readOnly: true, "aria-readonly": true } : {})}
          className={`${inputClass} read-only:bg-muted read-only:text-muted-foreground`}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sign-up-password" className="am-h4">
          Password
        </label>
        <PasswordInput
          id="sign-up-password"
          name="password"
          autoComplete="new-password"
          placeholder="At least 12 characters"
          aria-describedby="sign-up-password-hint"
          required
          minLength={MIN_PASSWORD}
          className={inputClass}
        />
        <span id="sign-up-password-hint" className="am-micro">
          At least {MIN_PASSWORD} characters. A passphrase works well.
        </span>
      </div>
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
        {pending ? "Creating your account…" : "Create account"}
      </button>
    </form>
  );
}
