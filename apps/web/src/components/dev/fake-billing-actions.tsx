// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "@/components/api";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

export type FakeAction = {
  action: string;
  label: string;
  primary?: boolean;
  /** Asks how many days (advance clock). */
  days?: boolean;
};

/**
 * Buttons that drive the fake billing provider in dev (ADR-0029 §3): each one posts to `/api/dev/billing/simulate`,
 * which delivers the fake's signed events through the real webhook. The page reloads to show the fake's new state.
 */
export function FakeBillingActions({
  target,
  actions,
  after,
}: {
  target: { sessionId: string } | { customerId: string };
  actions: readonly FakeAction[];
  /** Where to go after a successful action (the checkout's "Pay"), else the page refreshes. */
  after?: Partial<Record<string, string>>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  async function run(a: FakeAction) {
    setBusy(a.action);
    setMessage(null);
    const res = await callApi("/api/dev/billing/simulate", {
      method: "POST",
      body: { action: a.action, ...target, ...(a.days ? { days } : {}) },
    });
    setBusy(null);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    const next = after?.[a.action];
    if (next) window.location.assign(next);
    else {
      setMessage(`Done: ${a.label.toLowerCase()}.`);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {actions.some((a) => a.days) && (
        <label className="flex items-center gap-2 text-sm">
          Days to advance
          <input
            type="number"
            min={1}
            max={800}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
            }}
            className="h-9 w-24 rounded-lg border bg-background px-2 font-mono"
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(a)}
            className={a.primary ? primaryButtonClass : secondaryButtonClass}
          >
            {busy === a.action ? "Working…" : a.label}
          </button>
        ))}
      </div>
      <p role="status" className="am-small min-h-5">
        {message}
      </p>
    </div>
  );
}
