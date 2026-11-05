// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { POW_HEADERS, SIGN_UP_CODE_HEADER, SIGN_UP_REFUSAL } from "@anhourmail/shared/proof-of-work";
import { BREACHED_PASSWORD } from "@anhourmail/shared/security";

import { useHydrated } from "@/components/use-hydrated";

import { PasswordInput } from "@/components/password-input";

import { ProofStatus } from "./proof-status";
import { useSignUpProof } from "./use-sign-up-proof";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

const MIN_PASSWORD = 12;

/**
 * Sign-up: first name (required), last name (optional), display name (pre-filled from first + last and kept in
 * sync until edited; clearing it goes back to automatic). Posts to the auth endpoint; the SDK stays server-side
 * (ADR-0008) and the server re-validates and applies the same display-name default. A proof-of-work runs in the
 * background as the page opens and goes with the request (ADR-0031); a refused proof is solved again and sent once more.
 */
export function SignUpForm({
  inviteCode = null,
  codeRequired = false,
}: {
  /** From the link (`?code=`), prefilled. */
  inviteCode?: string | null;
  /** Sign-up is closed: only an invite code lets someone in. */
  codeRequired?: boolean;
} = {}) {
  const router = useRouter();
  const [code, setCode] = useState(inviteCode ?? "");
  const [showCode, setShowCode] = useState(codeRequired || inviteCode !== null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [displayEdited, setDisplayEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();
  const pow = useSignUpProof(hydrated, code.trim() === "" ? null : code.trim());

  const autoDisplay = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
  const shownDisplay = displayEdited ? displayName : autoDisplay;

  async function submit(form: FormData) {
    const emailValue = form.get("email");
    const email = typeof emailValue === "string" ? emailValue.trim() : "";
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
    if (codeRequired && code.trim() === "") {
      setError("Enter your invite code.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      // A refused proof (expired, or the network changed while solving) gets one fresh solve and one more try.
      for (let attempt = 0; attempt < 2; attempt++) {
        const proof = await pow.take();
        // The check's own status line says what went wrong.
        if (!proof) return;
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [POW_HEADERS.challenge]: proof.challenge,
            [POW_HEADERS.proof]: proof.proof,
            ...(code.trim() !== "" ? { [SIGN_UP_CODE_HEADER]: code.trim() } : {}),
          },
          body: JSON.stringify({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            name: shownDisplay.trim(),
            email,
            password,
          }),
        });
        if (res.ok) {
          router.replace("/");
          router.refresh();
          return;
        }
        // The identity layer answers `{ code, message }`; the sign-up gate and the route `{ error: { code, message } }`.
        const json = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
          error?: { code?: string };
        } | null;
        const gate = json?.error?.code;
        if (gate === SIGN_UP_REFUSAL.proofOfWork && attempt === 0) {
          pow.restart();
          continue;
        }
        pow.restart();
        if (gate === SIGN_UP_REFUSAL.proofOfWork) setError("The automatic check didn't go through. Try again.");
        else if (gate === SIGN_UP_REFUSAL.inviteCode) {
          setError("That invite code isn't valid. Check it, or ask whoever sent it.");
        } else if (gate === SIGN_UP_REFUSAL.attempts) {
          setError("Too many sign-up attempts from your network. Try again later.");
        } else if (gate === SIGN_UP_REFUSAL.limited) {
          setError("Too many accounts were created from your network recently. Try again later.");
        } else if (res.status === 429) setError("Too many attempts. Wait a minute and try again.");
        else if (res.status === 503) setError("Sign-up is unavailable for a moment. Try again shortly.");
        else if (res.status === 403) setError("Sign-up isn't available right now.");
        else if (json?.code === BREACHED_PASSWORD.authCode) setError(BREACHED_PASSWORD.message);
        // The shared name rules' own sentence (no control characters, @ or web addresses in names).
        else if (json?.code === "INVALID_NAME" && json.message) setError(json.message);
        else if (res.status === 422 || res.status === 400) {
          setError("We couldn't create that account. Check your details, or sign in if you already have one.");
        } else setError("Something went wrong. Try again in a moment.");
        return;
      }
    } catch {
      pow.restart();
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
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
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
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          className={inputClass}
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
      {showCode ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="sign-up-invite-code" className="am-h4">
            Invite code {!codeRequired && <span className="am-micro font-normal">(optional)</span>}
          </label>
          <input
            id="sign-up-invite-code"
            name="inviteCode"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={code}
            placeholder="XXXX-XXXX-XXXX-…"
            aria-describedby="sign-up-invite-code-hint"
            onChange={(e) => {
              setCode(e.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
          <span id="sign-up-invite-code-hint" className="am-micro">
            {codeRequired
              ? "Sign-up is by invitation for now. Use the code you were sent."
              : "If you were sent a code, it can come with a paid plan for a while."}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setShowCode(true);
          }}
          className="am-small w-fit text-primary underline-offset-2 hover:underline"
        >
          Have an invite code?
        </button>
      )}
      <ProofStatus state={pow.state} onRetry={pow.restart} />
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
        {pending
          ? pow.state.status === "solving"
            ? "Finishing the check…"
            : "Creating your account…"
          : "Create account"}
      </button>
    </form>
  );
}
