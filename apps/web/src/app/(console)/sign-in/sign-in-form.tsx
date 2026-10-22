// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { TOTP, TRUSTED_DEVICE_DAYS } from "@anhourmail/shared/security";

import { PasswordInput } from "@/components/password-input";
import { assertPasskey, authCall, passkeyError, passkeysSupported } from "@/components/security/webauthn";
import { useHydrated } from "@/components/use-hydrated";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
const primary =
  "h-10 rounded-lg bg-primary font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60";
const secondary =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border text-[15px] transition-colors hover:bg-accent disabled:opacity-60";
const textLink = "am-small w-fit underline-offset-2 hover:text-foreground hover:underline";

type Step = "password" | "code" | "recovery";

/** The second step's error codes, in plain words. A finished or expired challenge sends them back to the start. */
function secondStepMessage(code: string, status: number): { message: string; restart: boolean } {
  switch (code) {
    case "INVALID_CODE":
      return { message: "That code isn't right. Check your authenticator app and try again.", restart: false };
    case "INVALID_BACKUP_CODE":
      return { message: "That recovery code isn't right, or it was already used.", restart: false };
    case "SIGN_IN_METHOD_REQUIRED":
      return { message: "", restart: true };
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return { message: "Too many wrong codes. Sign-in is locked for 15 minutes; try again later.", restart: true };
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "INVALID_TWO_FACTOR_COOKIE":
      return { message: "This sign-in expired or had too many wrong codes. Start again.", restart: true };
    default:
      return {
        message: status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Something went wrong.",
        restart: false,
      };
  }
}

/**
 * Sign-in: email and password, then — when two-factor sign-in is on — a code from an authenticator app or a recovery
 * code; or a passkey on its own. Posts to the auth endpoints directly; the SDK stays server-side in packages/adapters
 * (ADR-0008). `next` is where to go afterwards — the page passes only paths it has checked (an invite link), never an
 * arbitrary URL. The second step's challenge lives in a short-lived cookie set by the password step.
 */
export function SignInForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  const done = () => {
    router.replace(next);
    router.refresh();
  };

  async function onPassword(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const res = await authCall("/sign-in/email", {
      method: "POST",
      body: { email: form.get("email"), password: form.get("password") },
    });
    setPending(false);
    if (res.ok) {
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) setStep("code");
      else done();
      return;
    }
    setError(
      res.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : res.code === "network" || res.code === "SIGN_IN_METHOD_REQUIRED"
          ? res.message
          : "Email or password is wrong.",
    );
  }

  async function onSecondStep(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const raw = form.get("code");
    const code = typeof raw === "string" ? raw.trim() : "";
    if (code === "") {
      setError(step === "code" ? "Enter the code from your authenticator app." : "Enter one of your recovery codes.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await authCall(step === "code" ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code", {
      method: "POST",
      body: { code, trustDevice: form.get("trust") === "on" },
    });
    setPending(false);
    if (res.ok) {
      done();
      return;
    }
    const m = secondStepMessage(res.code, res.status);
    setError(m.message === "" ? res.message : m.message);
    if (m.restart) setStep("password");
  }

  async function onPasskey() {
    setPending(true);
    setError(null);
    try {
      const options = await authCall("/passkey/generate-authenticate-options", {
        method: "GET",
      });
      if (!options.ok) {
        setError(options.message);
        return;
      }
      const response = await assertPasskey(options.data as Parameters<typeof assertPasskey>[0]);
      const res = await authCall("/passkey/verify-authentication", { method: "POST", body: { response } });
      if (res.ok) {
        done();
        return;
      }
      setError(
        res.code === "USER_NOT_VERIFIED"
          ? res.message
          : res.status === 429
            ? res.message
            : "That passkey didn't work. It may have been removed from your login.",
      );
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setPending(false);
    }
  }

  const passkeyButton = hydrated && passkeysSupported() && (
    <button type="button" disabled={pending} onClick={() => void onPasskey()} className={secondary}>
      <KeyRound className="size-4" aria-hidden />
      Sign in with a passkey
    </button>
  );

  const alert = error && (
    <p role="alert" className="am-small text-destructive">
      {error}
    </p>
  );

  if (step !== "password") {
    const recovery = step === "recovery";
    return (
      <form
        method="post"
        onSubmit={(e) => {
          void onSecondStep(e);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="am-h3">{recovery ? "Use a recovery code" : "Two-step sign-in"}</h2>
          <p className="am-small">
            {recovery
              ? "Enter one of the recovery codes you saved when you turned on two-factor sign-in. Each code works once."
              : `Enter the ${String(TOTP.digits)}-digit code from your authenticator app.`}
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">{recovery ? "Recovery code" : "Code"}</span>
          <input
            key={step}
            name="code"
            {...(recovery
              ? {
                  autoComplete: "off",
                  placeholder: "XXXX-XXXX-XXXX-XXXX",
                  spellCheck: false,
                  autoCapitalize: "characters",
                }
              : { inputMode: "numeric" as const, autoComplete: "one-time-code", placeholder: "123456", maxLength: 6 })}
            required
            autoFocus
            className={`${inputClass} font-mono tracking-wider`}
          />
        </label>
        <label className="flex items-center gap-2.5">
          <input type="checkbox" name="trust" className="size-4 accent-primary" />
          <span className="am-small text-foreground">
            Trust this browser for {TRUSTED_DEVICE_DAYS} days (skip this step here)
          </span>
        </label>
        {alert}
        <button type="submit" disabled={pending || !hydrated} className={primary}>
          {pending ? "Checking…" : "Continue"}
        </button>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setStep(recovery ? "code" : "recovery");
              setError(null);
            }}
            className={`${textLink} text-left`}
          >
            {recovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("password");
              setError(null);
            }}
            className={`${textLink} text-left`}
          >
            Start again
          </button>
        </div>
        {passkeyButton && (
          <div className="flex flex-col gap-3">
            <p className="am-micro">Or skip both steps with a passkey:</p>
            {passkeyButton}
          </div>
        )}
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        onSubmit={(e) => {
          void onPassword(e);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username webauthn"
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
            <Link href="/forgot-password" className={textLink}>
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
        {alert}
        <button type="submit" disabled={pending || !hydrated} className={primary}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {passkeyButton && (
        <>
          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            <span className="am-micro">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {passkeyButton}
        </>
      )}
    </div>
  );
}
