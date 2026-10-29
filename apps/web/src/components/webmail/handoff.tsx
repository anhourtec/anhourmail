// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

const CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Redeems the console's one-time code (ADR-0024): reads it from the URL fragment, removes it from the address bar and
 * history before anything else, and POSTs it to the BFF on this origin (the verifier cookie goes with it). On success
 * it replaces this page with the inbox; on a refusal it says why and links to the ordinary sign-in and the console.
 */
export function WebmailHandoff({ home, signIn, consoleUrl }: { home: string; signIn: string; consoleUrl: string }) {
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const code = window.location.hash.replace(/^#/, "");
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      if (!CODE.test(code)) {
        setError("This link to your mailbox isn't complete. Open webmail from the console again.");
        return;
      }
      try {
        const res = await fetch("/api/webmail/handoff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (res.ok) {
          window.location.replace(home);
          return;
        }
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(
          res.status === 429
            ? "Too many attempts. Wait a few minutes, or sign in with your mailbox password."
            : (json?.error?.message ?? "Your mailbox couldn't be opened. Sign in with your mailbox password instead."),
        );
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    })();
  }, [home]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="am-small rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive"
        >
          {error}
        </p>
      ) : (
        <p role="status" className="am-small text-muted-foreground">
          Opening…
        </p>
      )}
      <div className="flex flex-col gap-2">
        <a href={signIn} className="am-small underline underline-offset-4">
          Sign in with your mailbox password instead
        </a>
        <a href={consoleUrl} className="am-small underline underline-offset-4">
          Back to the console
        </a>
      </div>
    </div>
  );
}
