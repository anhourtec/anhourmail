// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { PASSKEY_NAME_MAX } from "@anhourmail/shared/security";

import { callApi } from "../api";
import { ConfirmDialog, inlineActionClass } from "../console/flyout";
import { StatusText } from "../console/status-text";
import { useHydrated } from "../use-hydrated";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { StepUpForm } from "./step-up-form";
import { RecoveryCodes } from "./two-factor-settings";
import { authCall, createPasskey, passkeyError, passkeysSupported } from "./webauthn";

export type PasskeyRow = {
  id: string;
  name: string;
  added: string | null;
  /** Synced across devices (a password manager or platform account) rather than one security key. */
  synced: boolean;
};

/** Registration error codes from the identity layer, in plain words. */
function addError(code: string, fallback: string): string {
  if (code === "SESSION_NOT_FRESH" || code === "SESSION_EXPIRED") {
    return "For safety, adding a passkey needs a recent sign-in. Sign out, sign in again, then add it.";
  }
  if (code === "USER_NOT_VERIFIED" || code === "INVALID_NAME") return fallback;
  return "The passkey couldn't be added. Try again.";
}

function PasskeyItem({ p }: { p: PasskeyRow }) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const url = `/api/me/passkeys/${encodeURIComponent(p.id)}`;

  return (
    <li className="flex flex-col gap-2 border-b px-1 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-medium">{p.name}</span>
            <span className="am-micro">
              {p.synced ? "Synced passkey" : "Device-bound key"}
              {p.added ? ` · added ${p.added}` : ""}
            </span>
          </div>
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-3">
            <button
              type="button"
              onClick={() => {
                setEditing(true);
              }}
              className={inlineActionClass}
            >
              <Pencil className="size-3.5" aria-hidden />
              Rename<span className="sr-only"> {p.name}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm(true);
              }}
              className={inlineActionClass}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Remove<span className="sr-only"> {p.name}</span>
            </button>
          </div>
        )}
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            void callApi(url, { method: "PATCH", body: { name } }).then((res) => {
              setPending(false);
              if (!res.ok) {
                setError(res.message);
                return;
              }
              setEditing(false);
              router.refresh();
            });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor={`${id}-name`} className="sr-only">
            New name for {p.name}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={PASSKEY_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className={`${inputClass} sm:max-w-72`}
          />
          <button type="submit" disabled={pending} className={primaryButtonClass}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(p.name);
              setError(null);
            }}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Remove ${p.name}?`}
          confirmLabel="Remove passkey"
          pendingLabel="Removing…"
          onCancel={() => {
            setConfirm(false);
          }}
          onConfirm={async () => {
            const res = await callApi(url, { method: "DELETE" });
            if (!res.ok && res.code === "step_up_required") {
              // Removing a passkey needs the console password from the last few minutes (ADR-0028).
              setConfirm(false);
              setStepUp(true);
              return null;
            }
            if (!res.ok) return res.message;
            setConfirm(false);
            router.refresh();
            return null;
          }}
        >
          It won&apos;t work as your second step any more. You can also delete it from the device or password manager
          that holds it.
        </ConfirmDialog>
      )}
      {stepUp && (
        <StepUpForm
          why="Removing a passkey changes how you sign in, so it needs your console password."
          confirmLabel="Confirm and remove"
          onConfirmed={async () => {
            const res = await callApi(url, { method: "DELETE" });
            setStepUp(false);
            if (!res.ok) {
              setError(res.message);
              return;
            }
            router.refresh();
          }}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      )}
    </li>
  );
}

/**
 * Passkeys and security keys: a phishing-resistant second step after the password (they check your PIN, fingerprint
 * or face; ADR-0028). Add, rename and remove. Passkeys work only on the console's own address.
 */
export function PasskeySettings({ passkeys }: { passkeys: PasskeyRow[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  /** The server wants a recent confirmation (the console password) before a passkey can be added. */
  const [stepUp, setStepUp] = useState(false);
  /** Recovery codes issued with a first passkey, shown once. */
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const supported = hydrated && passkeysSupported();

  async function add() {
    setPending(true);
    setError(null);
    try {
      const options = await authCall("/passkey/generate-register-options", {
        method: "GET",
      });
      if (!options.ok) {
        if (options.code === "STEP_UP_REQUIRED") setStepUp(true);
        else setError(addError(options.code, options.message));
        return;
      }
      const response = await createPasskey(options.data as Parameters<typeof createPasskey>[0]);
      const res = await authCall("/passkey/verify-registration", {
        method: "POST",
        body: { response, ...(name.trim() ? { name } : {}) },
      });
      if (!res.ok) {
        if (res.code === "STEP_UP_REQUIRED") setStepUp(true);
        else setError(addError(res.code, res.message));
        return;
      }
      setAdding(false);
      setName("");
      // A first second factor comes with recovery codes, shown once (ADR-0028).
      const codes = (res.data as { recoveryCodes?: unknown } | null)?.recoveryCodes;
      if (Array.isArray(codes) && codes.every((c) => typeof c === "string")) setFreshCodes(codes);
      router.refresh();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="am-h4">Passkeys and security keys</h3>
            <p className="am-small">
              After your password, confirm it&apos;s you with your fingerprint, face, device PIN or a security key.
            </p>
            {passkeys.length > 0 ? (
              <StatusText tone="success">
                {passkeys.length} {passkeys.length === 1 ? "passkey" : "passkeys"}
              </StatusText>
            ) : (
              <StatusText tone="neutral">None yet</StatusText>
            )}
          </div>
        </div>
        {!adding && (
          <button
            type="button"
            disabled={!supported}
            onClick={() => {
              setAdding(true);
            }}
            className={passkeys.length === 0 ? primaryButtonClass : secondaryButtonClass}
          >
            <Plus className="size-4" aria-hidden />
            Add a passkey
          </button>
        )}
      </div>
      {hydrated && !supported && (
        <p className="am-small">
          This browser can&apos;t create passkeys here. Use a current browser on the console&apos;s own address.
        </p>
      )}
      {freshCodes && (
        <RecoveryCodes
          codes={freshCodes}
          fresh
          onDone={() => {
            setFreshCodes(null);
            router.refresh();
          }}
        />
      )}
      {adding && stepUp && (
        <StepUpForm
          why="For safety, adding a passkey needs your console password."
          confirmLabel="Confirm and continue"
          onConfirmed={async () => {
            setStepUp(false);
            await add();
          }}
          onCancel={() => {
            setAdding(false);
            setStepUp(false);
            setError(null);
          }}
        />
      )}
      {adding && !stepUp && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          className="flex max-w-md flex-col gap-3"
        >
          <label htmlFor={`${id}-name`} className="am-h4">
            Name <span className="am-small font-normal">(so you can tell them apart)</span>
          </label>
          <input
            id={`${id}-name`}
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            maxLength={PASSKEY_NAME_MAX}
            placeholder="Work laptop"
            className={inputClass}
          />
          {error && (
            <p role="alert" className="am-small text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              {pending ? "Waiting for your passkey…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {passkeys.length > 0 && (
        <ul aria-label="Your passkeys" className="border-t">
          {passkeys.map((p) => (
            <PasskeyItem key={p.id} p={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The person's passkeys with Rename and Remove, for the "check your passkeys" notice after a password reset. */
export function PasskeyReviewList({ passkeys }: { passkeys: PasskeyRow[] }) {
  return (
    <ul aria-label="Passkeys to check" className="border-t">
      {passkeys.map((p) => (
        <PasskeyItem key={p.id} p={p} />
      ))}
    </ul>
  );
}
