// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "../api";
import { dangerButtonClass } from "../ui-classes";

/** Staff: revoke one unused invite code (it stops working at once). */
export function RevokeInviteCode({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label={`Revoke ${label}`}
        onClick={() => {
          setBusy(true);
          setError(null);
          void callApi(`/api/platform/invite-codes/${encodeURIComponent(id)}`, { method: "DELETE" }).then((res) => {
            setBusy(false);
            if (!res.ok) setError(res.message);
            else router.refresh();
          });
        }}
        className={`${dangerButtonClass} h-8 px-3 text-[14px]`}
      >
        {busy ? "Revoking…" : "Revoke"}
      </button>
      {error && (
        <p role="alert" className="am-micro text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
