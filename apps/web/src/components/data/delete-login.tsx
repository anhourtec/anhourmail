// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState } from "react";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { dangerButtonClass, inputClass } from "../ui-classes";

/**
 * "Delete your login" (ADR-0025): shown only when nothing stops it (the page lists blockers otherwise). The sign-in
 * address typed exactly, a step-up if asked; then the person is signed out and taken to the sign-in page.
 */
export function DeleteLogin({ email, accountsDeleted }: { email: string; accountsDeleted: string[] }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await callApi("/api/me/login", { method: "DELETE", body: { confirmEmail: typed } });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    window.location.assign("/sign-in");
  }

  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ul className="am-small flex list-disc flex-col gap-1.5 pl-5 text-foreground">
        <li>
          Your sessions, sign-in methods, profile details and photo are deleted at once, and you&apos;re signed out.
        </li>
        <li>You leave every account you belong to. Their admins see that you left.</li>
        {accountsDeleted.length > 0 && (
          <li>
            These empty accounts that only you own are deleted with it:{" "}
            {accountsDeleted.map((n, i) => (
              <span key={`${String(i)}-${n}`} className="font-mono">
                {i > 0 ? ", " : ""}
                {n}
              </span>
            ))}
            .
          </li>
        )}
        <li>This can&apos;t be undone. You can sign up again later, but nothing comes back.</li>
      </ul>
      <label htmlFor={`${id}-email`} className="am-h4">
        Type <span className="font-mono">{email}</span> to confirm
      </label>
      <input
        id={`${id}-email`}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
        }}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} max-w-md`}
      />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {stepUp && (
        <StepUpForm
          why="Deleting your login can't be undone, so we check it's you."
          onConfirmed={async () => {
            setStepUp(false);
            await submit();
          }}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      )}
      <div>
        <button type="button" onClick={() => void submit()} disabled={busy || !matches} className={dangerButtonClass}>
          Delete my login
        </button>
      </div>
    </div>
  );
}
