// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import type { HandoffMailbox } from "@anhourmail/core/webmail";

import { StepUpForm } from "@/components/security/step-up-form";

const button =
  "flex h-10 w-full items-center justify-between gap-3 rounded-lg border bg-background px-3 text-left text-[15px] transition-colors hover:bg-muted disabled:opacity-60";

const UNAVAILABLE: Record<NonNullable<HandoffMailbox["unavailable"]>, string> = {
  mailbox_unavailable: "Can't be opened right now",
  password_change_required: "Needs a new password first: sign in with the one you were given",
};

/**
 * Mints the one-time code for the chosen mailbox (same-origin POST) and moves to the webmail page with the code in the
 * URL fragment, which no server and no `Referer` ever sees. Without a challenge (the page was opened directly, or the
 * verifier is gone) it starts over on the webmail origin. Every refusal offers the ordinary sign-in page.
 */
export function OpenWebmail({
  challenge,
  mailboxes,
  autoStart,
  startUrl,
  signInUrl,
}: {
  challenge: string | null;
  mailboxes: HandoffMailbox[];
  autoStart: string | null;
  startUrl: string;
  signInUrl: string;
}) {
  // The pre-selected mailbox shows "Opening…" from the first render; its request starts once mounted.
  const [pending, setPending] = useState<string | null>(autoStart);
  const [error, setError] = useState<string | null>(null);
  /** The mailbox waiting for "Confirm it's you" (the server answered 403 `step_up_required`). */
  const [confirming, setConfirming] = useState<HandoffMailbox | null>(null);
  const started = useRef(false);

  /** Asks for the code and moves on; state changes only after the request answers. */
  async function mint(m: HandoffMailbox) {
    if (!challenge) {
      // Start again on the webmail origin, which sets this browser's verifier and comes back with a challenge.
      window.location.assign(`${startUrl}?mailbox=${encodeURIComponent(m.mailboxId)}`);
      return;
    }
    let message: string;
    try {
      const res = await fetch(
        `/api/accounts/${encodeURIComponent(m.accountId)}/mailboxes/${encodeURIComponent(m.mailboxId)}/webmail-handoff`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) },
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { url?: string };
        error?: { code?: string; message?: string };
      } | null;
      const url = json?.data?.url;
      if (res.ok && url) {
        window.location.replace(url);
        return;
      }
      if (json?.error?.code === "step_up_required") {
        setConfirming(m);
        setPending(null);
        return;
      }
      message =
        res.status === 429
          ? "Too many attempts. Wait a few minutes, or sign in with your mailbox password."
          : (json?.error?.message ?? "That didn't work. Try again, or sign in with your mailbox password.");
    } catch {
      message = "Couldn't reach the server. Check your connection and try again.";
    }
    setError(message);
    setPending(null);
  }

  function open(m: HandoffMailbox) {
    setPending(m.mailboxId);
    setError(null);
    void mint(m);
  }

  useEffect(() => {
    if (started.current || !autoStart) return;
    const m = mailboxes.find((x) => x.mailboxId === autoStart);
    if (!m) return;
    started.current = true;
    // After this render: `mint` only changes state once its request has answered.
    void Promise.resolve().then(() => mint(m));
    // Runs once, for the pre-selected mailbox.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `mint` reads the same props; re-running would mint again
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {mailboxes.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Your mailboxes">
          {mailboxes.map((m) => (
            <li key={m.mailboxId}>
              <button
                type="button"
                className={button}
                disabled={m.unavailable !== null || pending !== null}
                onClick={() => {
                  open(m);
                }}
              >
                <span className="truncate font-mono text-[14px]">{m.address}</span>
                <span className="am-small shrink-0 text-muted-foreground">
                  {m.unavailable ? UNAVAILABLE[m.unavailable] : pending === m.mailboxId ? "Opening…" : "Open"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <StepUpForm
          why="Your mailbox opens without its password, so confirm it's you first."
          onConfirmed={async () => {
            const m = confirming;
            setConfirming(null);
            setPending(m.mailboxId);
            await mint(m);
          }}
          onCancel={() => {
            setConfirming(null);
          }}
        />
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <a href={signInUrl} className="am-small underline underline-offset-4">
        Sign in with your mailbox password instead
      </a>
    </div>
  );
}
