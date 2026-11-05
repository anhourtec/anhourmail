// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { dangerButtonClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * A billing action that asks first: a button opens a short panel saying what will happen, "Confirm" sends the request,
 * and when the server asks for a fresh confirmation that it's you (403 `step_up_required`, ADR-0028) the password
 * step-up appears and the request is sent again. The button stays disabled while the request runs, so a double click
 * never sends it twice. On success the page refreshes (the server's answer is the truth).
 */
export function ConfirmAction({
  label,
  icon,
  tone = "secondary",
  title,
  children,
  confirmLabel,
  url,
  method = "POST",
  body,
  why,
  done,
  extra,
}: {
  label: string;
  /** A Lucide icon element (`<Ban className="size-4" aria-hidden />`): elements cross from server pages, components don't. */
  icon?: ReactNode;
  tone?: "primary" | "secondary" | "danger";
  /** The panel's heading. */
  title: string;
  /** What happens, in plain words (shown before anything is sent). */
  children: ReactNode;
  confirmLabel: string;
  url: string;
  method?: "POST" | "PUT" | "DELETE";
  body?: () => unknown;
  /** Why the step-up asks (one sentence). */
  why: string;
  /** Shown after it went through, until the page refreshes. */
  done: string;
  /** Extra fields inside the panel (e.g. a checkbox); `body` reads them. */
  extra?: ReactNode;
}) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const buttonClass =
    tone === "primary" ? primaryButtonClass : tone === "danger" ? dangerButtonClass : secondaryButtonClass;

  function close() {
    setOpen(false);
    setStepUp(false);
    setError(null);
  }

  async function send() {
    setBusy(true);
    setError(null);
    const payload = body?.();
    const res = await callApi(url, { method, ...(payload === undefined ? {} : { body: payload }) });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    close();
    setMessage(done);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
          className={`${buttonClass} w-fit`}
        >
          {icon}
          {label}
        </button>
        {message && (
          <p role="status" className="am-small">
            {message}
          </p>
        )}
      </div>
    );
  }

  if (stepUp) {
    return (
      <StepUpForm
        why={why}
        onConfirmed={async () => {
          setStepUp(false);
          await send();
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
        void send();
      }}
      className="flex w-full max-w-lg flex-col gap-3 rounded-xl border bg-background p-4"
      noValidate
    >
      <h4 id={`${id}-title`} className="am-h4">
        {title}
      </h4>
      <div className="am-small flex max-w-prose flex-col gap-2 text-foreground">{children}</div>
      {extra}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={tone === "danger" ? dangerButtonClass : primaryButtonClass}>
          {busy ? "Working…" : confirmLabel}
        </button>
        <button type="button" onClick={close} className={secondaryButtonClass}>
          Keep things as they are
        </button>
      </div>
    </form>
  );
}
