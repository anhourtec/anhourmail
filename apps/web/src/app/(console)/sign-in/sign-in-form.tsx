// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { isSecondStepMethod, type SecondStepMethod, TOTP, TRUSTED_DEVICE_DAYS } from "@anhourmail/shared/security";

import { PasswordInput } from "@/components/password-input";
import { assertPasskey, authCall, passkeyError, passkeysSupported } from "@/components/security/webauthn";
import { useHydrated } from "@/components/use-hydrated";

const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
const primary =
  "h-10 rounded-lg bg-primary font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60";
const textLink = "am-small w-fit underline-offset-2 hover:text-foreground hover:underline";

type Step = "password" | "passkey" | "code" | "recovery";

/** The second step's error codes, in plain words. A finished or expired challenge sends them back to the start. */
function secondStepMessage(code: string, status: number): { message: string; restart: boolean } {
  switch (code) {
    case "INVALID_CODE":
      return { message: "That code isn't right. Check your authenticator app and try again.", restart: false };
    case "INVALID_BACKUP_CODE":
      return { message: "That recovery code isn't right, or it was already used.", restart: false };
    case "PASSKEY_NOT_FOUND":
      return { message: "That passkey isn't one of yours. Try another one.", restart: false };
    case "USER_NOT_VERIFIED":
      return { message: "", restart: false };
    case "SIGN_IN_METHOD_REQUIRED":
      return { message: "", restart: true };
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return { message: "Too many wrong attempts. Sign-in is locked for 15 minutes; try again later.", restart: true };
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "INVALID_TWO_FACTOR_COOKIE":
    case "PASSWORD_FIRST":
      return { message: "This sign-in expired or had too many wrong attempts. Start again.", restart: true };
    default:
      return {
        message:
          status === 429
            ? "Too many attempts. Wait a few minutes and try again."
            : code === "AUTHENTICATION_FAILED"
              ? "That passkey didn't work. Try again, or use another way."
              : "Something went wrong.",
        restart: false,
      };
  }
}

/** The second-step methods the password step offered, in the order the page prefers them. */
function offered(data: unknown): SecondStepMethod[] {
  const raw = (data as { twoFactorMethods?: unknown } | null)?.twoFactorMethods;
  const list = Array.isArray(raw) ? raw.filter(isSecondStepMethod) : [];
  // An answer without a list comes from an authenticator app (the two-factor plugin's own shape).
  return list.length > 0 ? list : ["totp", "recovery_code"];
}

/**
 * Sign-in (ADR-0028): email and password, always first. Someone with a second factor then gets a second step: their
 * passkey or security key, a code from their authenticator app, or a recovery code (the lost-factor fallback) —
 * whichever the server offered. Posts to the auth endpoints directly; the SDK stays server-side in packages/adapters
 * (ADR-0008). `next` is where to go afterwards — the page passes only paths it has checked (an invite link), never an
 * arbitrary URL. The second step's challenge lives in a short-lived cookie set by the password step.
 */
export function SignInForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [methods, setMethods] = useState<SecondStepMethod[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** "Trust this browser" on the passkey step (the code steps read it from their form). */
  const [trustPasskey, setTrustPasskey] = useState(false);
  const hydrated = useHydrated();

  const done = () => {
    router.replace(next);
    router.refresh();
  };

  const restart = () => {
    setStep("password");
    setMethods([]);
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
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) {
        const list = offered(res.data);
        setMethods(list);
        setStep(list[0] === "passkey" ? "passkey" : list.includes("totp") ? "code" : "recovery");
      } else done();
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

  function fail(code: string, status: number, message: string) {
    const m = secondStepMessage(code, status);
    setError(m.message === "" ? message : m.message);
    if (m.restart) restart();
  }

  async function onCode(e: SyntheticEvent<HTMLFormElement>) {
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
    if (res.ok) done();
    else fail(res.code, res.status, res.message);
  }

  async function onPasskey() {
    setPending(true);
    setError(null);
    try {
      const options = await authCall("/passkey/generate-authenticate-options", { method: "GET" });
      if (!options.ok) {
        fail(options.code, options.status, options.message);
        return;
      }
      const response = await assertPasskey(options.data as Parameters<typeof assertPasskey>[0]);
      const res = await authCall("/passkey/verify-authentication", {
        method: "POST",
        body: { response, trustDevice: trustPasskey },
      });
      if (res.ok) done();
      else fail(res.code, res.status, res.message);
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setPending(false);
    }
  }

  const alert = error && (
    <p role="alert" className="am-small text-destructive">
      {error}
    </p>
  );

  /** Links to the other second-step methods offered, then "Start again". */
  const otherWays = (
    <div className="flex flex-col gap-2">
      {step !== "passkey" && methods.includes("passkey") && (
        <button
          type="button"
          onClick={() => {
            setStep("passkey");
            setError(null);
          }}
          className={`${textLink} text-left`}
        >
          Use your passkey instead
        </button>
      )}
      {step !== "code" && methods.includes("totp") && (
        <button
          type="button"
          onClick={() => {
            setStep("code");
            setError(null);
          }}
          className={`${textLink} text-left`}
        >
          Use your authenticator app instead
        </button>
      )}
      {step !== "recovery" && methods.includes("recovery_code") && (
        <button
          type="button"
          onClick={() => {
            setStep("recovery");
            setError(null);
          }}
          className={`${textLink} text-left`}
        >
          Use a recovery code instead
        </button>
      )}
      {!methods.includes("recovery_code") && (
        <Link href="/forgot-password" className={textLink}>
          Lost your passkey? Reset your password
        </Link>
      )}
      <button
        type="button"
        onClick={() => {
          restart();
          setError(null);
        }}
        className={`${textLink} text-left`}
      >
        Start again
      </button>
    </div>
  );

  if (step === "passkey") {
    const supported = hydrated && passkeysSupported();
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="am-h3">Two-step sign-in</h2>
          <p className="am-small">Use your passkey or security key to finish signing in.</p>
        </div>
        {hydrated && !supported && (
          <p className="am-small">
            This browser can&apos;t use passkeys here. Use a current browser on the console&apos;s own address
            {methods.length > 1 ? ", or another way below." : "."}
          </p>
        )}
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            name="trust"
            checked={trustPasskey}
            onChange={(e) => {
              setTrustPasskey(e.target.checked);
            }}
            className="size-4 accent-primary"
          />
          <span className="am-small text-foreground">
            Trust this browser for {TRUSTED_DEVICE_DAYS} days (skip this step here)
          </span>
        </label>
        {alert}
        <button
          type="button"
          disabled={pending || !supported}
          onClick={() => void onPasskey()}
          className={`${primary} inline-flex items-center justify-center gap-2`}
        >
          <KeyRound className="size-4" aria-hidden />
          {pending ? "Waiting for your passkey…" : "Use your passkey"}
        </button>
        {otherWays}
      </div>
    );
  }

  if (step !== "password") {
    const recovery = step === "recovery";
    return (
      <form
        method="post"
        onSubmit={(e) => {
          void onCode(e);
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
        {otherWays}
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
    </div>
  );
}
