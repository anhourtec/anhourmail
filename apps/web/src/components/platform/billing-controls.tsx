// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Gift, RotateCcw, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { PLANS } from "@anhourmail/shared/plans";

import { callApi } from "../api";
import { ConfirmAction } from "../billing/confirm-action";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, secondaryButtonClass } from "../ui-classes";

const WHY = "Staff billing changes need your console password.";

/** A form that sends one staff request and, when the server asks, the password step-up first (ADR-0028). */
function useStaffRequest(url: string, method: "PUT" | "POST" | "DELETE") {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function send(body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(false);
    const res = await callApi(url, { method, body });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(body);
      else setError(res.message);
      return;
    }
    setDone(true);
    router.refresh();
  }
  const stepUpForm =
    stepUp === undefined ? null : (
      <StepUpForm
        why={WHY}
        onConfirmed={async () => {
          const body = stepUp;
          setStepUp(undefined);
          await send(body);
        }}
        onCancel={() => {
          setStepUp(undefined);
        }}
      />
    );
  return { busy, error, done, send, stepUpForm };
}

/**
 * Staff: give the account Plus or Supporter without a payment, for some days (a comp, which lapses at its end) or with
 * no end date. Not over a paying subscription (the server refuses it).
 */
export function GrantPlanControl({ accountId }: { accountId: string }) {
  const id = useId();
  const [plan, setPlan] = useState<"plus" | "supporter">("plus");
  const [ends, setEnds] = useState(true);
  const [days, setDays] = useState("30");
  const { busy, error, done, send, stepUpForm } = useStaffRequest(
    `/api/platform/accounts/${encodeURIComponent(accountId)}/billing/grant`,
    "PUT",
  );
  if (stepUpForm) return stepUpForm;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send({ plan, days: ends ? Number(days) : null });
      }}
      className="flex max-w-lg flex-col gap-3 rounded-xl border p-4"
      noValidate
    >
      <h4 className="am-h4">Grant a plan</h4>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-plan`} className="am-small text-foreground">
            Plan
          </label>
          <select
            id={`${id}-plan`}
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value as "plus" | "supporter");
            }}
            className={`${inputClass} w-40`}
          >
            <option value="plus">{PLANS.plus.name}</option>
            <option value="supporter">{PLANS.supporter.name}</option>
          </select>
        </div>
        <label className="flex h-10 items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            checked={ends}
            onChange={(e) => {
              setEnds(e.target.checked);
            }}
            className="accent-[rgb(var(--primary))]"
          />
          Ends after
        </label>
        {ends && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-days`} className="am-small text-foreground">
              Days (1–365)
            </label>
            <input
              id={`${id}-days`}
              inputMode="numeric"
              value={days}
              onChange={(e) => {
                setDays(e.target.value.replace(/\D/g, ""));
              }}
              className={`${inputClass} am-num w-24`}
            />
          </div>
        )}
      </div>
      <p className="am-micro">
        Recorded in the account&apos;s audit log as Anhourtec staff. A lapsed account gets everything on hold back.
      </p>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="am-small">
          Granted.
        </p>
      )}
      <button type="submit" disabled={busy} className={`${secondaryButtonClass} w-fit`}>
        <Gift className="size-4" aria-hidden />
        {busy ? "Granting…" : "Grant plan"}
      </button>
    </form>
  );
}

/** Staff: end a staff grant or a comp now (the account drops to Free, holding what doesn't fit). */
export function EndGrantControl({ accountId }: { accountId: string }) {
  return (
    <ConfirmAction
      label="End the granted plan"
      icon={<XCircle className="size-4" aria-hidden />}
      tone="danger"
      title="End the granted plan now"
      confirmLabel="End it now"
      url={`/api/platform/accounts/${encodeURIComponent(accountId)}/billing/grant`}
      method="DELETE"
      why={WHY}
      done="Ended. The account is on Free; anything that doesn't fit is held."
    >
      <p>The account moves to Free at once. What doesn&apos;t fit Free is held, never deleted.</p>
    </ConfirmAction>
  );
}

/** Staff: refund the latest paid invoice in full, outside the self-service rules, optionally ending the plan now. */
export function StaffRefundControl({ accountId }: { accountId: string }) {
  const [end, setEnd] = useState(false);
  return (
    <ConfirmAction
      label="Refund the last payment"
      icon={<RotateCcw className="size-4" aria-hidden />}
      tone="danger"
      title="Refund the latest paid invoice"
      confirmLabel="Refund in full"
      url={`/api/platform/accounts/${encodeURIComponent(accountId)}/billing/refund`}
      body={() => ({ endSubscription: end })}
      why={WHY}
      done="Refunded. The account's billing updates within a minute."
      extra={
        <label className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            checked={end}
            onChange={(e) => {
              setEnd(e.target.checked);
            }}
            className="accent-[rgb(var(--primary))]"
          />
          Also end the subscription now
        </label>
      }
    >
      <p>
        The latest paid invoice is refunded in full, whenever it was paid. It doesn&apos;t use the account&apos;s own
        self-service refund. Refused while a payment is disputed.
      </p>
    </ConfirmAction>
  );
}

/**
 * Staff: the account's address ceiling (mailboxes and aliases together). The number is never shown to the customer;
 * staff set a higher (or lower) one, or go back to the configured default.
 */
export function CeilingOverrideControl({
  accountId,
  override,
  configured,
}: {
  accountId: string;
  override: number | null;
  configured: number;
}) {
  const id = useId();
  const [value, setValue] = useState(override === null ? "" : String(override));
  const { busy, error, done, send, stepUpForm } = useStaffRequest(
    `/api/platform/accounts/${encodeURIComponent(accountId)}/billing/address-ceiling`,
    "PUT",
  );
  if (stepUpForm) return stepUpForm;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send({ ceiling: Number(value) });
      }}
      className="flex max-w-lg flex-col gap-3 rounded-xl border p-4"
      noValidate
    >
      <h4 className="am-h4">Address ceiling</h4>
      <p className="am-small">
        Mailboxes and aliases one account can hold. Default <span className="am-num">{configured}</span>
        {override !== null && (
          <>
            ; this account: <span className="am-num">{override}</span>
          </>
        )}
        . Customers only see that a ceiling exists.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-ceiling`} className="am-small text-foreground">
            Ceiling for this account
          </label>
          <input
            id={`${id}-ceiling`}
            inputMode="numeric"
            value={value}
            placeholder={String(configured)}
            onChange={(e) => {
              setValue(e.target.value.replace(/\D/g, ""));
            }}
            className={`${inputClass} am-num w-32`}
          />
        </div>
        <button type="submit" disabled={busy || value === ""} className={secondaryButtonClass}>
          Save
        </button>
        {override !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send({ ceiling: null })}
            className={secondaryButtonClass}
          >
            Back to the default
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="am-small">
          Saved.
        </p>
      )}
    </form>
  );
}
