// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "../api";

const small =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors disabled:opacity-60";

/**
 * Per-row controls: an on/off switch and a two-step delete (no browser dialogs). Both apply on the mail server
 * once the worker syncs the mailbox.
 */
export function AliasActions({
  accountId,
  aliasId,
  address,
  enabled,
}: {
  accountId: string;
  aliasId: string;
  address: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/accounts/${accountId}/aliases/${aliasId}`;

  async function run(init: Parameters<typeof callApi>[1]) {
    setPending(true);
    setError(null);
    const res = await callApi(url, init);
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Receive mail at ${address}`}
          disabled={pending}
          onClick={() => void run({ method: "PATCH", body: { enabled: !enabled } })}
          className="relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border bg-muted transition-colors aria-checked:border-primary aria-checked:bg-primary disabled:opacity-60"
        >
          <span
            aria-hidden
            className={`size-4 rounded-full bg-background shadow-sm transition-transform ${enabled ? "translate-x-[1.125rem]" : "translate-x-0.5"}`}
          />
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => void run({ method: "DELETE" })}
              className={`${small} border-destructive/40 text-destructive hover:bg-destructive/10`}
            >
              {pending ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className={`${small} hover:bg-accent`}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={`Delete ${address}`}
            onClick={() => {
              setConfirming(true);
            }}
            className={`${small} text-muted-foreground hover:bg-accent hover:text-foreground`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="am-micro text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
