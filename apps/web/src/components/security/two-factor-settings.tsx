// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, Download, ShieldCheck, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useMemo, useState } from "react";

import { RECOVERY_CODES, TOTP } from "@anhourmail/shared/security";

import { StatusText } from "../console/status-text";
import { CopyValue } from "../copy-value";
import { PasswordInput } from "../password-input";
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { qrMatrix, qrPath } from "./qr";
import { authCall } from "./webauthn";

type Mode =
  | { kind: "idle" }
  | { kind: "start" }
  | { kind: "scan"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[]; fresh: boolean }
  | { kind: "regenerate" }
  | { kind: "disable" };

/** Error codes from the identity layer, in plain words. */
function message(code: string, fallback: string): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That password isn't right.";
    case "INVALID_CODE":
      return fallback.includes("already used") ? fallback : "That code isn't right. Check the app and try again.";
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FRESH":
      return "For safety this needs a recent sign-in. Sign out, sign in again, then retry.";
    default:
      return fallback;
  }
}

/** The authenticator secret from an `otpauth://` link, in groups of four for typing. */
function secretOf(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/** The set-up QR code, drawn here (no image service ever sees the secret). */
function SetupQr({ uri }: { uri: string }) {
  const matrix = useMemo(() => qrMatrix(uri), [uri]);
  const size = matrix.length + 8;
  return (
    <svg
      role="img"
      aria-label="QR code to scan with your authenticator app"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      // Always ink on white, in both themes: authenticator apps expect dark modules on a light background.
      className="size-48 shrink-0 rounded-lg border bg-[rgb(var(--brand-fg))] text-[rgb(var(--am-ink))]"
      shapeRendering="crispEdges"
    >
      <path d={qrPath(matrix)} fill="currentColor" />
    </svg>
  );
}

function RecoveryCodes({ codes, fresh, onDone }: { codes: string[]; fresh: boolean; onDone: () => void }) {
  const text = codes.join("\n");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-4 rounded-lg border px-4 py-4">
      <div className="flex flex-col gap-1">
        <h4 className="am-h4">{fresh ? "Save your recovery codes" : "Your new recovery codes"}</h4>
        <p className="am-small">
          Each code signs you in once if you lose your authenticator app. Keep them somewhere safe, such as a password
          manager. They won&apos;t be shown again{fresh ? "" : ", and your old codes no longer work"}.
        </p>
      </div>
      <ol aria-label="Recovery codes" className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {codes.map((c) => (
          <li key={c} className="font-mono text-[14px] tracking-wide">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
            });
          }}
          className={secondaryButtonClass}
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`AnhourMail recovery codes\n\n${text}\n`)}`}
          download="anhourmail-recovery-codes.txt"
          className={secondaryButtonClass}
        >
          <Download className="size-4" aria-hidden />
          Download
        </a>
        <button type="button" onClick={onDone} className={primaryButtonClass}>
          I&apos;ve saved them
        </button>
      </div>
    </div>
  );
}

/**
 * Two-factor sign-in with an authenticator app, and its recovery codes. Turning it on: password → scan the QR code
 * (or type the secret) → enter a code → save the recovery codes. Turning it off needs the password and a current
 * code. New recovery codes replace the old ones.
 */
export function TwoFactorSettings({ enabled, recoveryCodesLeft }: { enabled: boolean; recoveryCodesLeft: number }) {
  const router = useRouter();
  const id = useId();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode({ kind: "idle" });
    setError(null);
  };
  const field = (e: SyntheticEvent<HTMLFormElement>, name: string) => {
    const v = new FormData(e.currentTarget).get(name);
    return typeof v === "string" ? v : "";
  };

  /** Posts to an auth endpoint; `ok` gets the JSON answer (the caller reads the fields it expects). */
  async function run(path: string, body: unknown, ok: (data: unknown) => void) {
    setPending(true);
    setError(null);
    const res = await authCall(path, { method: "POST", body });
    setPending(false);
    if (res.ok) ok(res.data);
    else setError(message(res.code, res.message));
  }

  const alert = error && (
    <p role="alert" className="am-small text-destructive">
      {error}
    </p>
  );
  const cancel = (
    <button type="button" onClick={reset} className={secondaryButtonClass}>
      Cancel
    </button>
  );
  const low = enabled && recoveryCodesLeft <= RECOVERY_CODES.warnAtOrBelow;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="am-h4">Authenticator app</h3>
            <p className="am-small">
              After your password, enter a {TOTP.digits}-digit code from an app on your phone or computer.
            </p>
            {enabled ? <StatusText tone="success">On</StatusText> : <StatusText tone="neutral">Off</StatusText>}
          </div>
        </div>
        {mode.kind === "idle" &&
          (enabled ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode({ kind: "regenerate" });
                }}
                className={secondaryButtonClass}
              >
                New recovery codes
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode({ kind: "disable" });
                }}
                className={dangerButtonClass}
              >
                Turn off
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode({ kind: "start" });
              }}
              className={primaryButtonClass}
            >
              <ShieldCheck className="size-4" aria-hidden />
              Turn on
            </button>
          ))}
      </div>

      {enabled && mode.kind === "idle" && (
        <p className={`am-small ${low ? "text-foreground" : ""}`}>
          {low ? (
            <StatusText tone="warning">
              {recoveryCodesLeft === 0
                ? "No recovery codes left. Create new ones so you can still sign in without your app."
                : `Only ${String(recoveryCodesLeft)} recovery ${recoveryCodesLeft === 1 ? "code" : "codes"} left. Create new ones soon.`}
            </StatusText>
          ) : (
            <span>{`${String(recoveryCodesLeft)} of ${String(RECOVERY_CODES.count)} recovery codes left.`}</span>
          )}
        </p>
      )}

      {mode.kind === "start" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const password = field(e, "password");
            void run("/two-factor/enable", { password }, (data) => {
              const d = data as { totpURI: string; backupCodes: string[] };
              setMode({ kind: "scan", uri: d.totpURI, codes: d.backupCodes });
            });
          }}
          className="flex max-w-md flex-col gap-3"
        >
          <label htmlFor={`${id}-pw`} className="am-h4">
            Confirm your password
          </label>
          <PasswordInput
            id={`${id}-pw`}
            name="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
          {alert}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              {pending ? "Checking…" : "Continue"}
            </button>
            {cancel}
          </div>
        </form>
      )}

      {mode.kind === "scan" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = field(e, "code").trim();
            void run("/two-factor/verify-totp", { code }, () => {
              setMode({ kind: "codes", codes: mode.codes, fresh: true });
            });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <SetupQr uri={mode.uri} />
            <div className="flex min-w-0 flex-col gap-3">
              <p className="am-small">
                1. Scan this code with your authenticator app. Can&apos;t scan? Add an account by hand with this key:
              </p>
              <CopyValue value={secretOf(mode.uri)} label="set-up key" />
              <label htmlFor={`${id}-code`} className="am-small">
                2. Enter the {TOTP.digits}-digit code the app shows:
              </label>
              <input
                id={`${id}-code`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={TOTP.digits}
                placeholder="123456"
                required
                className={`${inputClass} max-w-48 font-mono tracking-wider`}
              />
              {alert}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={pending} className={primaryButtonClass}>
                  {pending ? "Checking…" : "Turn on"}
                </button>
                {cancel}
              </div>
            </div>
          </div>
        </form>
      )}

      {mode.kind === "codes" && (
        <RecoveryCodes
          codes={mode.codes}
          fresh={mode.fresh}
          onDone={() => {
            reset();
            router.refresh();
          }}
        />
      )}

      {mode.kind === "regenerate" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("/two-factor/generate-backup-codes", { password: field(e, "password") }, (data) => {
              setMode({ kind: "codes", codes: (data as { backupCodes: string[] }).backupCodes, fresh: false });
            });
          }}
          className="flex max-w-md flex-col gap-3"
        >
          <p className="am-small">New codes replace all your current recovery codes.</p>
          <label htmlFor={`${id}-rpw`} className="am-h4">
            Confirm your password
          </label>
          <PasswordInput
            id={`${id}-rpw`}
            name="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
          {alert}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              {pending ? "Creating…" : "Create new codes"}
            </button>
            {cancel}
          </div>
        </form>
      )}

      {mode.kind === "disable" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("/two-factor/disable", { password: field(e, "password"), code: field(e, "code").trim() }, () => {
              reset();
              router.refresh();
            });
          }}
          className="flex max-w-md flex-col gap-3"
        >
          <p className="am-small">
            Without it, your password alone signs you in. Your recovery codes stop working too.
          </p>
          <label htmlFor={`${id}-dpw`} className="am-h4">
            Password
          </label>
          <PasswordInput
            id={`${id}-dpw`}
            name="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
          <label htmlFor={`${id}-dcode`} className="am-h4">
            Current code or a recovery code
          </label>
          <input
            id={`${id}-dcode`}
            name="code"
            autoComplete="one-time-code"
            required
            className={`${inputClass} font-mono tracking-wider`}
          />
          {alert}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={dangerButtonClass}>
              {pending ? "Turning off…" : "Turn off two-factor sign-in"}
            </button>
            {cancel}
          </div>
        </form>
      )}
    </div>
  );
}
