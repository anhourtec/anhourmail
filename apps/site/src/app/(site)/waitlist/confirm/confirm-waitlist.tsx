// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type State = "confirming" | "confirmed" | "invalid" | "error";

/**
 * Confirms the waitlist address from the emailed link (double opt-in). The token is sent once, by POST, to
 * /api/public/waitlist/confirm; it never reaches analytics or logs (there are none on this site).
 */
/**
 * One request per token per page load. React re-runs effects in development (mount → unmount → mount); without
 * this the second POST would be refused (single-use token) and replace the first, successful answer.
 */
const inFlight = new Map<string, Promise<State>>();

function confirmOnce(token: string): Promise<State> {
  let pending = inFlight.get(token);
  if (!pending) {
    pending = fetch("/api/public/waitlist/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res): State => (res.ok ? "confirmed" : res.status === 400 || res.status === 404 ? "invalid" : "error"))
      .catch((): State => "error");
    inFlight.set(token, pending);
  }
  return pending;
}

export function ConfirmWaitlist({ token }: { token: string | null }) {
  const [state, setState] = useState<State>(token ? "confirming" : "invalid");

  useEffect(() => {
    if (!token) return;
    const live = { current: true };
    void confirmOnce(token).then((result) => {
      if (live.current) setState(result);
    });
    return () => {
      live.current = false;
    };
  }, [token]);

  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-5">
      {state === "confirming" && <p>Confirming your address…</p>}
      {state === "confirmed" && (
        <>
          <p>You’re on the list. We’ll email you once when your invite is ready — nothing else.</p>
          <Link href="/" className="am-site-btn am-site-btn--glass h-[46px] px-5">
            Back to the home page
          </Link>
        </>
      )}
      {state === "invalid" && (
        <>
          <p>This link has expired or was already used. Join again and we’ll send a fresh one.</p>
          <Link href="/waitlist" className="am-site-btn am-site-btn--primary h-[46px] px-5">
            Join the waitlist
          </Link>
        </>
      )}
      {state === "error" && <p>Something went wrong on our side. Open the link again in a moment.</p>}
    </div>
  );
}
