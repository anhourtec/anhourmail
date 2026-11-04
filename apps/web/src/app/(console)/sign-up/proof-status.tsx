// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldCheck } from "lucide-react";

import type { ProofState } from "./use-sign-up-proof";

const FAILED: Record<Extract<ProofState, { status: "failed" }>["reason"], string> = {
  unsupported:
    "This browser couldn't run the automatic check. Update it or try another browser, over a secure (https) connection.",
  network: "Couldn't start the automatic check. Check your connection and try again.",
  limited: "Too many attempts from your network. Wait a few minutes and try again.",
  error: "The automatic check stopped. Try again.",
};

/**
 * What the sign-up proof-of-work is doing (ADR-0031): a progress bar while it runs, a short line once done, and a clear
 * reason with "Try again" if it fails. Announced politely to screen readers; never needs the person to do anything.
 */
export function ProofStatus({ state, onRetry }: { state: ProofState; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="sign-up-check" data-status={state.status}>
      <p aria-live="polite" className="am-micro flex items-center gap-1.5">
        {state.status === "solving" && <>Running a quick automatic check that keeps automated sign-ups out…</>}
        {state.status === "ready" && (
          <>
            <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-primary" />
            Automatic check done.
          </>
        )}
        {state.status === "failed" && <span className="text-destructive">{FAILED[state.reason]}</span>}
      </p>
      {state.status === "solving" && (
        <div
          role="progressbar"
          aria-label="Automatic check"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress}
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${String(Math.max(4, state.progress))}%` }}
          />
        </div>
      )}
      {state.status === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="self-start am-small font-medium text-foreground underline underline-offset-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}
