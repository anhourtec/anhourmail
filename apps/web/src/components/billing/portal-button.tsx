// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { callApi } from "../api";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * "Manage payment and invoices": asks our server for the payment processor's portal (card, billing address, tax ids,
 * invoices and receipts) and goes there with a top-level navigation. Disabled from the first click.
 */
export function PortalButton({
  accountId,
  label = "Manage payment and invoices",
  primary = false,
}: {
  accountId: string;
  label?: string;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/portal`, { method: "POST" });
    const url = res.ok ? (res.data as { url?: unknown } | undefined)?.url : undefined;
    if (typeof url !== "string") {
      setBusy(false);
      setError(res.ok ? "Something went wrong. Try again." : res.message);
      return;
    }
    window.location.assign(url);
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className={`${primary ? primaryButtonClass : secondaryButtonClass} w-fit`}
      >
        <ExternalLink className="size-4" aria-hidden />
        {busy ? "Opening…" : label}
      </button>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
