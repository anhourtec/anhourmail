// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Eye, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { ACT_AS } from "@anhourmail/shared/platform";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The reason textarea with its rules: shown to the account's admins, never a secret. */
function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const length = value.trim().length;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="am-h4">
        Reason
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={ACT_AS.reasonMax}
        rows={3}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={`${inputClass} h-auto py-2`}
        placeholder="e.g. Ticket 1234: the owner asked why their domain isn't verifying"
      />
      <p id={`${id}-hint`} className="am-micro">
        The account&apos;s admins see this in their audit log and the Owners get it by email. Never paste passwords,
        codes or other secrets. <span className="am-num">{`${String(length)} / ${String(ACT_AS.reasonMax)}`}</span>
      </p>
    </div>
  );
}

const reasonOk = (r: string) => r.trim().length >= ACT_AS.reasonMin && r.trim().length <= ACT_AS.reasonMax;

/**
 * Staff (Global and Support Administrators, `platform.accounts.actAs`; ADR-0023): open a customer account read-only as
 * Anhourtec support. Asks for a reason, then a fresh confirmation that it's you when the server asks (403
 * `step_up_required`). On success the console shows the account as they'd see it, with a banner to end it.
 */
export function ActAsStart({ accountId, accountName }: { accountId: string; accountName: string }) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setStepUp(false);
    setError(null);
    setReason("");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await callApi(`/api/platform/accounts/${encodeURIComponent(accountId)}/act-as`, {
      method: "POST",
      body: { reason: reason.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    router.push(`/accounts/${encodeURIComponent(accountId)}/people`);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={secondaryButtonClass}
      >
        <Eye className="size-4" aria-hidden />
        Open with support access
      </button>
    );
  }

  if (stepUp) {
    return (
      <StepUpForm
        why="Support access opens a customer's account, so it needs your console password."
        onConfirmed={async () => {
          setStepUp(false);
          await submit();
        }}
        onCancel={close}
      />
    );
  }

  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex w-full max-w-lg flex-col gap-4 rounded-xl border p-4"
      noValidate
    >
      <h4 id={`${id}-title`} className="am-h4">
        Open this account with support access
      </h4>
      <p className="am-small max-w-prose">
        You&apos;ll see <span className="break-all">{accountName}</span> in the console as its admins do, read-only, for{" "}
        {ACT_AS.minutes} minutes (you can extend it). You can&apos;t change anything, open webmail or read mail. Every
        step is recorded in the account&apos;s audit log as Anhourtec staff, and its Owners are emailed now.
      </p>
      <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !reasonOk(reason)} className={primaryButtonClass}>
          {busy ? "Opening…" : "Open read-only"}
        </button>
        <button type="button" onClick={close} className={secondaryButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Whole minutes left (at least 0). */
const minutesLeft = (expiresAt: string, now: number) =>
  Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));

/**
 * The banner on every console page while staff act in an account (ADR-0023): whose account, that it is read-only,
 * when it ends, and End (back to the staff view) or Extend (a new reason and a fresh step-up). When the time runs out
 * the page reloads into the staff view; the server stops honouring the session at once either way.
 */
export function ActAsBanner({
  accountId,
  accountName,
  expiresAt: initialExpiry,
}: {
  accountId: string;
  accountName: string;
  /** ISO time the session ends. */
  expiresAt: string;
}) {
  const id = useId();
  const router = useRouter();
  // After an extension, until the refreshed page brings the new expiry down (ISO strings compare in time order).
  const [renewedTo, setRenewedTo] = useState<string | null>(null);
  const expiresAt = renewedTo !== null && renewedTo > initialExpiry ? renewedTo : initialExpiry;
  const [now, setNow] = useState(() => Date.now());
  const [renewing, setRenewing] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = minutesLeft(expiresAt, now);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (new Date(expiresAt).getTime() <= now) {
      router.push(`/platform/accounts/${encodeURIComponent(accountId)}`);
      router.refresh();
    }
  }, [accountId, expiresAt, now, router]);

  async function end() {
    setBusy(true);
    setError(null);
    const res = await callApi("/api/me/act-as", { method: "DELETE" });
    setBusy(false);
    // 404: it had already ended (expired); either way the staff view is next.
    if (!res.ok && res.status !== 404) {
      setError(res.message);
      return;
    }
    router.push(`/platform/accounts/${encodeURIComponent(accountId)}`);
    router.refresh();
  }

  async function renew() {
    setBusy(true);
    setError(null);
    const res = await callApi("/api/me/act-as/renew", { method: "POST", body: { reason: reason.trim() } });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    const data = res.data as { expiresAt?: unknown } | undefined;
    if (typeof data?.expiresAt === "string") setRenewedTo(data.expiresAt);
    setRenewing(false);
    setStepUp(false);
    setReason("");
    router.refresh();
  }

  return (
    <div
      role="region"
      aria-label="Support access"
      className="border-b border-l-4 border-l-[rgb(var(--am-status-warning))] bg-[rgb(var(--am-status-warning-bg)_/_0.14)] px-4 py-2.5 sm:px-6 lg:px-10"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-[14px]">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[rgb(var(--am-status-warning))]" aria-hidden />
          <span className="min-w-0">
            You&apos;re acting in <strong className="font-medium break-all">{accountName}</strong> as Anhourtec support
            — read-only. Ends at <span className="am-num">{timeFmt.format(new Date(expiresAt))}</span>{" "}
            <span className="am-small am-num">({left === 1 ? "1 minute" : `${String(left)} minutes`} left)</span>
          </span>
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!renewing && (
            <button
              type="button"
              onClick={() => {
                setRenewing(true);
              }}
              aria-label="Extend support access"
              className={secondaryButtonClass}
            >
              <RefreshCw className="size-4" aria-hidden />
              Extend
            </button>
          )}
          <button
            type="button"
            onClick={() => void end()}
            disabled={busy}
            aria-label="End support access"
            className={primaryButtonClass}
          >
            <LogOut className="size-4" aria-hidden />
            End
          </button>
        </div>
      </div>
      {error && !renewing && (
        <p role="alert" className="am-small mt-2 text-destructive">
          {error}
        </p>
      )}
      {renewing && (
        <div className="mt-3">
          {stepUp ? (
            <StepUpForm
              why="Extending support access needs your console password."
              onConfirmed={async () => {
                setStepUp(false);
                await renew();
              }}
              onCancel={() => {
                setStepUp(false);
                setRenewing(false);
              }}
            />
          ) : (
            <form
              role="dialog"
              aria-labelledby={`${id}-title`}
              onSubmit={(e) => {
                e.preventDefault();
                void renew();
              }}
              className="flex w-full max-w-lg flex-col gap-3 rounded-xl border bg-background p-4"
              noValidate
            >
              <h4 id={`${id}-title`} className="am-h4">
                Extend support access
              </h4>
              <p className="am-small">
                Another {ACT_AS.minutes} minutes from now, up to {ACT_AS.maxMinutes / 60} hours in all. Say why you
                still need it.
              </p>
              <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} />
              {error && (
                <p role="alert" className="am-small text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy || !reasonOk(reason)} className={primaryButtonClass}>
                  {busy ? "Extending…" : "Extend"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenewing(false);
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
      )}
    </div>
  );
}
