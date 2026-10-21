// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { dangerButtonClass, secondaryButtonClass } from "../ui-classes";
import { callApi } from "../api";

/** Two-step remove (no browser dialogs). The server refuses while mailboxes or aliases use the domain. */
export function RemoveDomain({ accountId, domainId, name }: { accountId: string; domainId: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/domains/${domainId}`, { method: "DELETE" });
    if (res.ok) {
      router.push(`/accounts/${accountId}/domains`);
      router.refresh();
      return;
    }
    setPending(false);
    setError(res.message);
  }

  return (
    <div className="flex flex-col gap-3">
      {confirming ? (
        <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 p-4">
          <p className="am-body">
            Remove <code className="am-code">{name}</code> from this account? Mail for it stops arriving here. You can
            add it again later.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void remove()} disabled={pending} className={dangerButtonClass}>
              <Trash2 className="size-4" aria-hidden />
              {pending ? "Removing…" : "Remove domain"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className={`${dangerButtonClass} w-fit`}
        >
          <Trash2 className="size-4" aria-hidden />
          Remove domain…
        </button>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
