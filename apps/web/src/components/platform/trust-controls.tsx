// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Ban, RotateCcw, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { SUSPENSION_REASONS } from "@anhourmail/shared/platform";
import { TRUST_TIERS, type TrustTier } from "@anhourmail/shared/sending";

import { callApi } from "../api";
import { ModalDialog } from "../console/flyout";
import { StepUpForm } from "../security/step-up-form";
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/** The longest staff note the server keeps (`TRUST_NOTE_MAX` in core). */
const NOTE_MAX = 2000;
const WHY = "Trust changes decide who can send mail, so they need your console password.";

/** The order the dialog offers the tiers in (`trusted` is shown, but can't be chosen yet). */
const CHOICES: readonly TrustTier[] = ["new", "standard", "trusted", "restricted"];

/** Why `trusted` can't be chosen (ADR-0034 §2): the mail server can't hold its numbers yet. */
export const TRUSTED_UNAVAILABLE =
  "Not available yet: the mail server can't hold a higher limit for one account, so nothing moves to Trusted for now.";

/** Whether a move needs a reason category: into `restricted`, and out of it (ADR-0034 §2). */
export const needsReason = (from: TrustTier, to: TrustTier) => to === "restricted" || from === "restricted";

/**
 * Sends one staff trust request and, when the server asks, the password step-up first (ADR-0028); the page refreshes on
 * success (the server's answer is the truth).
 */
function useTrustRequest(url: string, onDone: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<unknown>(undefined);
  async function send(body: unknown) {
    setBusy(true);
    setError(null);
    const res = await callApi(url, { method: "PUT", body });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(body);
      else setError(res.message);
      return;
    }
    onDone();
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
  return {
    busy,
    error,
    send,
    stepUpForm,
    reset: () => {
      setError(null);
    },
  };
}

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="am-h4">
        Reason
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={inputClass}
        required
      >
        <option value="">Choose a reason…</option>
        {Object.entries(SUSPENSION_REASONS).map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <p className="am-micro">The customer sees this in plain words while sending is paused.</p>
    </div>
  );
}

function NoteField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="am-h4">
        Internal note
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={NOTE_MAX}
        rows={3}
        required
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={`${inputClass} h-auto py-2`}
      />
      <p className="am-micro">Required. Staff only: never shown to the customer, put in emails or the audit log.</p>
    </div>
  );
}

/**
 * Staff (`platform.trust.manage`: Global and Trust & Safety Administrators): change an account's trust tier. The panel
 * offers New, Standard and Restricted (Trusted is shown, disabled, with why), asks for a reason category to restrict
 * and to leave Restricted, an internal note always, and whether automatic promotion and billing may move it again.
 * The server asks for a fresh step-up and refuses while acting as someone.
 */
export function ChangeTierControl({
  accountId,
  current,
  subject,
}: {
  accountId: string;
  current: TrustTier;
  /** The account's name, for the panel's wording. */
  subject: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<TrustTier | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [automatic, setAutomatic] = useState(false);
  const clear = () => {
    setOpen(false);
    setTier(null);
    setReason("");
    setNote("");
    setAutomatic(false);
  };
  const req = useTrustRequest(`/api/platform/accounts/${encodeURIComponent(accountId)}/trust`, clear);
  const close = () => {
    clear();
    req.reset();
  };

  const trigger = (
    <button
      type="button"
      onClick={() => {
        setOpen(true);
      }}
      className={`${secondaryButtonClass} w-fit`}
    >
      <ShieldCheck className="size-4" aria-hidden />
      Change tier
    </button>
  );
  if (!open) return trigger;

  const reasonNeeded = tier !== null && needsReason(current, tier);
  const canAuto = tier === "new" || tier === "standard";
  const ready = tier !== null && note.trim() !== "" && (!reasonNeeded || reason !== "");

  return (
    <>
      {trigger}
      <ModalDialog labelledBy={`${id}-title`} onClose={close}>
        <h2 id={`${id}-title`} className="am-h3 mb-4">
          Change the trust tier
        </h2>
        {req.stepUpForm ?? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready) return;
              void req.send({
                tier,
                note: note.trim(),
                ...(reasonNeeded ? { reason } : {}),
                ...(canAuto && automatic ? { automatic: true } : {}),
              });
            }}
            className="flex flex-col gap-4"
            noValidate
          >
            <p className="am-small max-w-prose">
              Every mailbox in <span className="break-all">{subject}</span> follows the new tier within a minute or two;
              the webmail applies it at once. The change is recorded in the account&apos;s audit log as Anhourtec staff.
            </p>
            <fieldset className="flex flex-col gap-2">
              <legend className="am-h4 mb-1.5">Tier</legend>
              {CHOICES.map((t) => {
                const unavailable = t === "trusted";
                return (
                  <label
                    key={t}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${unavailable ? "opacity-60" : "cursor-pointer hover:bg-accent"}`}
                  >
                    <input
                      type="radio"
                      name={`${id}-tier`}
                      value={t}
                      checked={tier === t}
                      disabled={unavailable}
                      aria-describedby={`${id}-${t}-d`}
                      onChange={() => {
                        setTier(t);
                      }}
                      className="mt-1 accent-[rgb(var(--primary))]"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-medium">
                        {TRUST_TIERS[t].label}
                        {t === current && <span className="am-small font-normal"> · current</span>}
                      </span>
                      <span id={`${id}-${t}-d`} className="am-micro">
                        {unavailable ? TRUSTED_UNAVAILABLE : TRUST_TIERS[t].description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {reasonNeeded && <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} />}
            <NoteField id={`${id}-note`} value={note} onChange={setNote} />
            {canAuto && (
              <label className="flex items-start gap-2.5 text-[14px]">
                <input
                  type="checkbox"
                  checked={automatic}
                  onChange={(e) => {
                    setAutomatic(e.target.checked);
                  }}
                  className="mt-1 accent-[rgb(var(--primary))]"
                />
                <span className="flex flex-col gap-0.5">
                  <span>Let automatic promotion and billing move it again</span>
                  <span className="am-micro">Otherwise it stays at this tier until staff change it.</span>
                </span>
              </label>
            )}
            {req.error && (
              <p role="alert" className="am-small text-destructive">
                {req.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={req.busy || !ready}
                className={tier === "restricted" ? dangerButtonClass : primaryButtonClass}
              >
                {req.busy ? "Working…" : tier === "restricted" ? "Restrict account" : "Change tier"}
              </button>
              <button type="button" onClick={close} className={secondaryButtonClass}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </>
  );
}

/**
 * Staff (`platform.trust.manage`): restrict one mailbox's sending, or lift that restriction (ADR-0034 §6). Both ways
 * need a reason category and an internal note; the server asks for a fresh step-up.
 */
export function MailboxSendingControl({
  accountId,
  mailboxId,
  address,
  restricted,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  restricted: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const clear = () => {
    setOpen(false);
    setReason("");
    setNote("");
  };
  const req = useTrustRequest(
    `/api/platform/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/sending`,
    clear,
  );
  const close = () => {
    clear();
    req.reset();
  };

  const trigger = (
    <button
      type="button"
      onClick={() => {
        setOpen(true);
      }}
      className={`${restricted ? secondaryButtonClass : dangerButtonClass} h-9 px-3 text-[14px]`}
    >
      {restricted ? <RotateCcw className="size-4" aria-hidden /> : <Ban className="size-4" aria-hidden />}
      {restricted ? "Lift restriction" : "Restrict sending"}
    </button>
  );
  if (!open) return trigger;

  const ready = reason !== "" && note.trim() !== "";
  return (
    <>
      {trigger}
      <ModalDialog labelledBy={`${id}-title`} onClose={close}>
        <h2 id={`${id}-title`} className="am-h3 mb-4">
          {restricted ? "Lift this mailbox's sending restriction" : "Restrict this mailbox's sending"}
        </h2>
        {req.stepUpForm ?? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready) return;
              void req.send({ restricted: !restricted, reason, note: note.trim() });
            }}
            className="flex flex-col gap-4"
            noValidate
          >
            <p className="am-small max-w-prose">
              {restricted ? (
                <>
                  <span className="am-code break-all">{address}</span> sends again at its account&apos;s tier.
                </>
              ) : (
                <>
                  <span className="am-code break-all">{address}</span> stops sending from the webmail and mail apps, and
                  its forwarding and automatic replies pause. It keeps receiving and reading mail. The rest of the
                  account is unchanged.
                </>
              )}
            </p>
            <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} />
            <NoteField id={`${id}-note`} value={note} onChange={setNote} />
            {req.error && (
              <p role="alert" className="am-small text-destructive">
                {req.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={req.busy || !ready}
                className={restricted ? primaryButtonClass : dangerButtonClass}
              >
                {req.busy ? "Working…" : restricted ? "Lift restriction" : "Restrict sending"}
              </button>
              <button type="button" onClick={close} className={secondaryButtonClass}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </>
  );
}
