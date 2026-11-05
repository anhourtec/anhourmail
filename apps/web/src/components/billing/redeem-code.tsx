// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { callApi } from "../api";
import { inputClass, secondaryButtonClass } from "../ui-classes";

/**
 * "Redeem a code" (ADR-0029 §8): a code from Anhourtec that gives this account a paid plan for a while, no card needed.
 * For accounts on Free or whose paid plan ended. Every wrong, used or expired code gets the same answer.
 */
export function RedeemCode({ accountId }: { accountId: string }) {
  const id = useId();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function redeem() {
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/redeem`, { method: "POST", body: { code } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setCode("");
    setDone("Redeemed. The plan is on now.");
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void redeem();
      }}
      className="flex max-w-xl flex-col gap-2"
      noValidate
    >
      <label htmlFor={`${id}-code`} className="am-small text-foreground">
        Code
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`${id}-code`}
          value={code}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-…"
          onChange={(e) => {
            setCode(e.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
        <button type="submit" disabled={busy || code.trim() === ""} className={secondaryButtonClass}>
          {busy ? "Checking…" : "Redeem"}
        </button>
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="am-small">
          {done}
        </p>
      )}
    </form>
  );
}
