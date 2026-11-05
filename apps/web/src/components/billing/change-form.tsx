// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";

import { type Currency, formatPrice } from "@anhourmail/shared/plans";

import { callApi } from "../api";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

type Preview = { amountDueNowMinor: number; currency: Currency; billed: "now" | "renewal" };

const isPreview = (v: unknown): v is Preview =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Preview).amountDueNowMinor === "number" &&
  typeof (v as Preview).currency === "string";

/**
 * Preview, then confirm (ADR-0029 §7, §9): "never auto-charged". The person edits a change (the `fields`), "Review the
 * change" asks the server what it costs now, and only the confirmation sends it, carrying the amount they saw: if the
 * amount moved meanwhile the server refuses (409 `confirmation_required`) and the new amount is shown to confirm again.
 * An increase is charged now, prorated, before tax; a decrease or a plan switch costs nothing now and renews at the new
 * figure. Editing the fields after a preview drops it.
 */
export function ChangeForm({
  accountId,
  body,
  changed,
  fields,
  onEdit,
  renewalText,
  submitLabel = "Review the change",
}: {
  accountId: string;
  /** The change as the routes take it. */
  body: Record<string, unknown>;
  /** Something differs from what's in force (otherwise nothing to review). */
  changed: boolean;
  fields: (onEdit: () => void) => ReactNode;
  /** Called when the person edits after a preview (drops it). */
  onEdit?: () => void;
  /** What a no-charge change does ("Renews with 2 storage blocks"). */
  renewalText: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const edited = () => {
    setPreview(null);
    setError(null);
    setMessage(null);
    onEdit?.();
  };

  async function review() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/preview`, { method: "POST", body });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!isPreview(res.data)) {
      setError("Something went wrong. Try again.");
      return;
    }
    setPreview(res.data);
  }

  async function confirm(p: Preview) {
    setBusy(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/change`, {
      method: "POST",
      body: { ...body, ...(p.billed === "now" ? { confirmAmountMinor: p.amountDueNowMinor } : {}) },
    });
    setBusy(false);
    if (!res.ok) {
      setPreview(null);
      setError(res.message);
      // The amount moved since the preview: show the new one to confirm again.
      if (res.code === "confirmation_required") await review();
      return;
    }
    setPreview(null);
    setMessage(
      p.billed === "now"
        ? `Done: ${formatPrice(p.amountDueNowMinor, p.currency)} charged. It shows here within a minute.`
        : "Done. It shows here within a minute.",
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {fields(edited)}
      {preview ? (
        <div
          role="group"
          aria-label="Confirm the change"
          className="flex max-w-lg flex-col gap-3 rounded-xl border p-4"
        >
          {preview.billed === "now" ? (
            <p className="am-small text-foreground">
              This charges{" "}
              <span className="am-num font-medium" data-testid="change-amount">
                {formatPrice(preview.amountDueNowMinor, preview.currency)}
              </span>{" "}
              now (before tax), for the rest of this period, to the card on file. It renews with the new quantities.
            </p>
          ) : (
            <p className="am-small text-foreground">
              Nothing is charged now. {renewalText} What you&apos;ve already paid for stays until the end of this
              period.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void confirm(preview)} className={primaryButtonClass}>
              {busy
                ? "Working…"
                : preview.billed === "now"
                  ? `Pay ${formatPrice(preview.amountDueNowMinor, preview.currency)} now`
                  : "Confirm the change"}
            </button>
            <button type="button" onClick={edited} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || !changed}
          onClick={() => void review()}
          className={`${secondaryButtonClass} w-fit`}
        >
          {busy ? "Checking…" : submitLabel}
        </button>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="am-small">
          {message}
        </p>
      )}
    </div>
  );
}
