// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { LifeBuoy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { RECOVERY_CODES } from "@anhourmail/shared/security";

import { StatusText } from "../console/status-text";
import { PasswordInput } from "../password-input";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { RecoveryCodes } from "./two-factor-settings";
import { authCall } from "./webauthn";

/**
 * Recovery codes for someone whose second factor is a passkey (no authenticator app; ADR-0028): how many are left, and
 * new ones with the console password (shown once; the old ones stop working). People who added their passkey before
 * recovery codes came with it have none yet, so this asks them to create a set.
 */
export function PasskeyRecoveryCodes({ recoveryCodesLeft }: { recoveryCodesLeft: number }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const none = recoveryCodesLeft === 0;
  const low = recoveryCodesLeft <= RECOVERY_CODES.warnAtOrBelow;

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        fresh={none}
        onDone={() => {
          setCodes(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <LifeBuoy className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="am-h4">Recovery codes</h3>
            <p className="am-small">If you lose your passkey, a recovery code works once as your second step.</p>
            {none ? (
              <StatusText tone="warning">
                You have no recovery codes. Create a set so you can still sign in without your passkey.
              </StatusText>
            ) : low ? (
              <StatusText tone="warning">
                {`Only ${String(recoveryCodesLeft)} recovery ${recoveryCodesLeft === 1 ? "code" : "codes"} left. Create new ones soon.`}
              </StatusText>
            ) : (
              <span className="am-small">{`${String(recoveryCodesLeft)} of ${String(RECOVERY_CODES.count)} recovery codes left.`}</span>
            )}
          </div>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
            className={none ? primaryButtonClass : secondaryButtonClass}
          >
            {none ? "Create recovery codes" : "New recovery codes"}
          </button>
        )}
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const raw = new FormData(e.currentTarget).get("password");
            const password = typeof raw === "string" ? raw : "";
            setPending(true);
            setError(null);
            void authCall("/recovery-codes/generate", { method: "POST", body: { password } }).then((res) => {
              setPending(false);
              if (!res.ok) {
                setError(res.status === 429 ? "Too many attempts. Wait a while and try again." : res.message);
                return;
              }
              setOpen(false);
              setCodes((res.data as { backupCodes: string[] }).backupCodes);
            });
          }}
          className="flex max-w-md flex-col gap-3"
        >
          {!none && <p className="am-small">New codes replace all your current recovery codes.</p>}
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
          {error && (
            <p role="alert" className="am-small text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              {pending ? "Creating…" : "Create codes"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
