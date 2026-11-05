// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { PLANS } from "@anhourmail/shared/plans";

import { callApi } from "../api";
import { CopyValue } from "../copy-value";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

const MAX_EXPIRY_DAYS = 90;
const MAX_COMP_DAYS = 365;

/**
 * Staff: create an invite code (ADR-0029 §8). What it grants is fixed here: sign-up while sign-up is closed (Global and
 * Support Administrators), a complimentary paid plan for some days (Global and Billing Administrators, with the password
 * step-up), or both. It always expires (at most 90 days) and can be bound to one email. The code is shown once.
 */
export function InviteCodeForm({
  canSignup,
  canComp,
  signUpUrl,
}: {
  canSignup: boolean;
  canComp: boolean;
  /** The console's sign-up page, for the link to send with a sign-up code. */
  signUpUrl: string;
}) {
  const id = useId();
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [grantsSignup, setGrantsSignup] = useState(canSignup);
  const [compPlan, setCompPlan] = useState<"" | "plus" | "supporter">(canSignup ? "" : "plus");
  const [compDays, setCompDays] = useState("30");
  const [email, setEmail] = useState("");
  const [expires, setExpires] = useState("30");
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; signup: boolean } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await callApi("/api/platform/invite-codes", {
      method: "POST",
      body: {
        label: label.trim(),
        grantsSignup,
        compPlan: compPlan === "" ? null : compPlan,
        compDays: compPlan === "" ? null : Number(compDays),
        email: email.trim() === "" ? null : email.trim(),
        expiresInDays: Number(expires),
      },
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    const code = (res.data as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") setCreated({ code, signup: grantsSignup });
    setLabel("");
    setEmail("");
    router.refresh();
  }

  if (stepUp) {
    return (
      <StepUpForm
        why="Codes that give a paid plan need your console password."
        onConfirmed={async () => {
          setStepUp(false);
          await submit();
        }}
        onCancel={() => {
          setStepUp(false);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {created && (
        <div
          role="status"
          className="flex max-w-2xl flex-col gap-2 rounded-xl border border-primary/40 p-4"
          data-testid="new-invite-code"
        >
          <p className="am-h4">Copy the code now: it can&apos;t be shown again.</p>
          <CopyValue value={created.code} label="invite code" />
          {created.signup && (
            <>
              <p className="am-small">Or send the sign-up link with the code in it:</p>
              <CopyValue value={`${signUpUrl}?code=${encodeURIComponent(created.code)}`} label="sign-up link" />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setCreated(null);
            }}
            className={`${secondaryButtonClass} w-fit`}
          >
            Done
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex max-w-2xl flex-col gap-4 rounded-xl border p-4"
        noValidate
      >
        <h3 className="am-h4">New code</h3>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-label`} className="am-small text-foreground">
            Note for staff (optional)
          </label>
          <input
            id={`${id}-label`}
            value={label}
            maxLength={200}
            placeholder="Beta wave 2"
            onChange={(e) => {
              setLabel(e.target.value);
            }}
            className={inputClass}
          />
        </div>
        {canSignup && (
          <label className="flex items-center gap-2 text-[15px]">
            <input
              type="checkbox"
              checked={grantsSignup}
              onChange={(e) => {
                setGrantsSignup(e.target.checked);
              }}
              className="accent-[rgb(var(--primary))]"
            />
            Lets someone sign up while sign-up is closed
          </label>
        )}
        {canComp && (
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-plan`} className="am-small text-foreground">
                Complimentary plan
              </label>
              <select
                id={`${id}-plan`}
                value={compPlan}
                onChange={(e) => {
                  setCompPlan(e.target.value as "" | "plus" | "supporter");
                }}
                className={`${inputClass} w-44`}
              >
                {canSignup && <option value="">None</option>}
                <option value="plus">{PLANS.plus.name}</option>
                <option value="supporter">{PLANS.supporter.name}</option>
              </select>
            </div>
            {compPlan !== "" && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-days`} className="am-small text-foreground">
                  For how many days (1–{MAX_COMP_DAYS})
                </label>
                <input
                  id={`${id}-days`}
                  inputMode="numeric"
                  value={compDays}
                  onChange={(e) => {
                    setCompDays(e.target.value.replace(/\D/g, ""));
                  }}
                  className={`${inputClass} am-num w-28`}
                />
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="am-small text-foreground">
              Only for this email (optional)
            </label>
            <input
              id={`${id}-email`}
              type="email"
              value={email}
              autoComplete="off"
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              className={`${inputClass} w-72`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-expires`} className="am-small text-foreground">
              Expires in days (1–{MAX_EXPIRY_DAYS})
            </label>
            <input
              id={`${id}-expires`}
              inputMode="numeric"
              value={expires}
              onChange={(e) => {
                setExpires(e.target.value.replace(/\D/g, ""));
              }}
              className={`${inputClass} am-num w-28`}
            />
          </div>
        </div>
        <p className="am-micro">Each code works once. Every wrong, used or expired code gets the same answer.</p>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={`${primaryButtonClass} w-fit`}>
          <Ticket className="size-4" aria-hidden />
          {busy ? "Creating…" : "Create code"}
        </button>
      </form>
    </div>
  );
}
