// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";

import { KNOWN_SOURCES } from "@anhourmail/shared/sources";

import { readAttribution } from "@/lib/attribution";

const COMMUNITY_LABELS: Record<(typeof KNOWN_SOURCES)[number], string> = {
  reddit: "Reddit",
  "hacker-news": "Hacker News",
  lemmy: "Lemmy",
  mastodon: "Mastodon",
  friend: "A friend",
  search: "Search",
  blog: "Our blog",
  other: "Somewhere else",
};

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string };

/**
 * Waitlist form → POST /api/public/waitlist (same origin through the site rewrite). Everyone who submits a valid
 * address sees the same confirmation, so the form never reveals who is already listed. A honeypot field and the
 * time the form was shown let the server drop bots silently.
 */
export function WaitlistForm({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const id = useId();
  const startedAt = useRef(0);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  async function submit(form: FormData) {
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const email = get("email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setState({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    const community = get("community");
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(community ? { community } : {}),
          ...readAttribution(),
          website: get("website"),
          startedAt: startedAt.current || Date.now(),
        }),
      });
      if (res.ok) setState({ kind: "done" });
      else if (res.status === 429)
        setState({ kind: "error", message: "Too many attempts. Try again in a few minutes." });
      else if (res.status === 400) setState({ kind: "error", message: "Enter a valid email address." });
      else setState({ kind: "error", message: "Something went wrong on our side. Try again in a moment." });
    } catch {
      setState({ kind: "error", message: "Couldn’t reach us. Check your connection and try again." });
    }
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit(new FormData(e.currentTarget));
  }

  const dark = tone === "dark";
  const field = dark
    ? "border-white/15 bg-white/5 text-white placeholder:text-white/50 focus-visible:ring-white/40"
    : "border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring";
  const muted = dark ? "text-white/65" : "text-muted-foreground";
  const linkHover = dark ? "hover:text-white" : "hover:text-foreground";

  if (state.kind === "done") {
    return (
      <div role="status" aria-live="polite" className="flex w-full max-w-md flex-col items-center gap-2">
        <p className={`font-display text-[18px] font-medium ${dark ? "text-white" : "text-foreground"}`}>
          Check your inbox to confirm.
        </p>
        <p className={`text-sm ${muted}`}>
          We sent a link to confirm your address. Didn’t get it? Check spam, or try again later.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <form onSubmit={onSubmit} noValidate aria-describedby={`${id}-status`} className="flex w-full flex-col gap-3">
        <div className="flex w-full flex-col gap-3 sm:flex-row">
          <label htmlFor={`${id}-email`} className="sr-only">
            Email address
          </label>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            className={`h-[45px] min-w-0 flex-1 rounded-lg border px-4 text-sm outline-none focus-visible:ring-2 ${field}`}
          />
          <button
            type="submit"
            disabled={state.kind === "sending"}
            className="am-site-btn am-site-btn--primary disabled:opacity-70"
          >
            {state.kind === "sending" ? "Joining…" : "Join the waitlist"}
          </button>
        </div>
        <label htmlFor={`${id}-community`} className={`flex items-center justify-center gap-2 text-[13px] ${muted}`}>
          <span>Where did you hear about us?</span>
          <select
            id={`${id}-community`}
            name="community"
            defaultValue=""
            className={`h-8 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-2 ${field}`}
          >
            <option value="">Prefer not to say</option>
            {KNOWN_SOURCES.map((s) => (
              <option key={s} value={s}>
                {COMMUNITY_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {/* Honeypot: hidden from people and assistive tech; bots that fill it are dropped server-side. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={`${id}-website`}>Website</label>
          <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        <p
          id={`${id}-status`}
          role="alert"
          aria-live="assertive"
          className={`min-h-5 text-center text-sm ${dark ? "am-site-error-on-dark" : "text-destructive"}`}
        >
          {state.kind === "error" ? state.message : ""}
        </p>
      </form>
      <p className={`text-[12.5px] ${muted}`}>
        By joining the waitlist, you agree to our{" "}
        <Link href="/legal/terms" className={`underline underline-offset-2 ${linkHover}`}>
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className={`underline underline-offset-2 ${linkHover}`}>
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
