// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { SIGN_IN_POLICIES, SIGN_IN_POLICY_LABELS, type SignInPolicy } from "@anhourmail/shared/security";

import { callApi } from "../api";
import { primaryButtonClass } from "../ui-classes";

const HELP: Record<SignInPolicy, string> = {
  none: "People choose for themselves.",
  two_factor: "Everyone needs an authenticator app or a passkey before they can use the console.",
  passkey: "Everyone needs a passkey or security key (the strongest protection against phishing).",
};

/**
 * What everyone in an account must use to sign in (Owners). People who don't have it yet are sent to their Security
 * page to set it up before they reach the console.
 */
export function SignInPolicyForm({
  accountId,
  accountName,
  policy,
}: {
  accountId: string;
  accountName: string;
  policy: SignInPolicy;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState<SignInPolicy>(policy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        setSaved(false);
        void callApi(`/api/accounts/${encodeURIComponent(accountId)}/sign-in-policy`, {
          method: "PUT",
          body: { policy: value },
        }).then((res) => {
          setPending(false);
          if (!res.ok) {
            setError(res.message);
            return;
          }
          setSaved(true);
          router.refresh();
        });
      }}
      className="flex flex-col gap-3"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="am-h4 mb-1">
          {accountName}
          <span className="sr-only">: sign-in requirement</span>
        </legend>
        {SIGN_IN_POLICIES.map((p) => (
          <label key={p} htmlFor={`${id}-${p}`} className="flex items-start gap-2.5">
            <input
              id={`${id}-${p}`}
              type="radio"
              name={`policy-${accountId}`}
              value={p}
              checked={value === p}
              onChange={() => {
                setValue(p);
                setSaved(false);
              }}
              className="mt-1 size-4 accent-primary"
            />
            <span className="flex flex-col">
              <span className="text-[14px] font-medium">{SIGN_IN_POLICY_LABELS[p]}</span>
              <span className="am-small">{HELP[p]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="am-small">
          Saved. Anyone who doesn&apos;t meet it yet is asked to set it up before they continue.
        </p>
      )}
      <div>
        <button type="submit" disabled={pending || value === policy} className={primaryButtonClass}>
          {pending ? "Saving…" : "Save requirement"}
        </button>
      </div>
    </form>
  );
}
