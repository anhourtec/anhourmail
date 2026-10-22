// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, EyeOff, ImageOff, Lock, ShieldCheck, Shuffle } from "lucide-react";
import { useRef } from "react";

import { ALIASES, usePrivacyLoop } from "./sign-in/use-privacy-loop";
import { useTilt } from "./sign-in/use-tilt";

/**
 * Brand panel beside the sign-in form: a "privacy desk" — three glass cards in a perspective stack showing
 * what AnhourMail does to every message (tracker blocked, remote images held back, a masked alias created),
 * over an aurora, a dot grid and film grain. Styles: `.am-si-*` in app/globals.css. Decorative layers are
 * aria-hidden; the facts list is plain text. The panel stays navy in light and dark mode.
 */
const FACTS = [
  { icon: ShieldCheck, text: "Open source, so anyone can check our work" },
  { icon: EyeOff, text: "No ads, no tracking pixels, no profiling" },
  { icon: ImageOff, text: "Remote images blocked until you allow them" },
] as const;

/** `domain`: the deployment's free address domain (`Platform.freeAddressDomain`), passed from the server. */
export function SignInVisual({ domain }: { domain: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const { step, typed, cycle } = usePrivacyLoop(panel);
  const tilt = useTilt(stack);
  const typing = step === 4;
  const aliasOn = step >= 5;
  // Between loops, keep the previous address (dimmed) so the field never shows an empty local part.
  const previous = ALIASES[(cycle + ALIASES.length - 1) % ALIASES.length] ?? ALIASES[0];
  const shown = typed === "" ? previous : typed;

  return (
    <div ref={panel} className="am-si-panel" onPointerMove={tilt.onPointerMove} onPointerLeave={tilt.onPointerLeave}>
      <div aria-hidden className="am-si-aurora">
        <span className="am-si-blob am-si-blob--a" />
        <span className="am-si-blob am-si-blob--b" />
        <span className="am-si-blob am-si-blob--c" />
      </div>
      <div aria-hidden className="am-si-grid" />
      <div aria-hidden className="am-si-grain" />

      <header className="relative flex flex-col gap-3">
        <p className="am-si-title">
          Your mail, <span className="am-si-title-accent">kept to yourself.</span>
        </p>
      </header>

      <div aria-hidden className="am-si-stage">
        <div ref={stack} className="am-si-stack" data-step={step}>
          {/* back: remote images held back */}
          <div className="am-si-card am-si-card--back">
            <div className="am-si-float" style={{ animationDelay: "-2s" }}>
              <div className="am-si-card-head">
                <span className="am-si-avatar am-si-avatar--muted">W</span>
                <div className="flex min-w-0 flex-col">
                  <span className="am-si-strong">Weekly deals</span>
                  <span className="am-si-faint">deals@shop.example</span>
                </div>
              </div>
              <div className="am-si-tiles" data-blocked={step >= 3}>
                {[0, 1].map((i) => (
                  <div key={i} className="am-si-tile">
                    <ImageOff className="am-si-tile-icon size-4" />
                  </div>
                ))}
              </div>
              <div className="am-si-row">
                <span className="am-si-state" data-done={step >= 3}>
                  <Lock className="size-3" />
                  <span className="am-si-state-text" data-done={step >= 3}>
                    <span>Loading 2 images…</span>
                    <span>2 remote images held back</span>
                  </span>
                </span>
                <span className="am-si-ghost-btn">Load images</span>
              </div>
            </div>
          </div>

          {/* middle: incoming message, tracker intercepted */}
          <div className="am-si-card am-si-card--mid">
            <div className="am-si-float" style={{ animationDelay: "-4s" }}>
              <div className="am-si-scan" data-run={step === 1} />
              <div className="am-si-card-head">
                <span className="am-si-avatar">N</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="am-si-strong">Your October picks</span>
                  <span className="am-si-faint">news@shop.example · just now</span>
                </div>
                <span className="am-si-pixel" data-caught={step >= 2} title="1×1 tracking pixel" />
              </div>
              <div className="am-si-lines">
                <span style={{ width: "92%" }} />
                <span style={{ width: "78%" }} />
                <span style={{ width: "54%" }} />
              </div>
              <div className="am-si-state" data-done={step >= 2}>
                <ShieldCheck className="size-3" />
                <span className="am-si-state-text" data-done={step >= 2}>
                  <span>Checking for trackers…</span>
                  <span>Tracking pixel removed</span>
                </span>
              </div>
            </div>
          </div>

          {/* front: masked alias being created */}
          <div className="am-si-card am-si-card--front">
            <div className="am-si-float" style={{ animationDelay: "-1s" }}>
              <div className="am-si-row">
                <span className="am-si-label">
                  <Shuffle className="size-3.5" /> New masked address
                </span>
                <span className="am-si-faint">for shop.example</span>
              </div>
              <div className="am-si-field" data-typing={typing}>
                <span className="am-si-mono">
                  <span className="am-si-typed" data-stale={typed === ""}>
                    {shown}
                  </span>
                  <span className="am-si-caret" />
                  <span className="am-si-domain">@{domain}</span>
                </span>
                {aliasOn ? <Check className="am-si-copied size-4" /> : <Copy className="size-4 opacity-60" />}
              </div>
              <div className="am-si-row">
                <span className="am-si-toggle" data-on={aliasOn}>
                  <span className="am-si-knob" />
                </span>
                <span className="am-si-state-text am-si-faint flex-1" data-done={aliasOn}>
                  <span>Forwarding off</span>
                  <span>Forwarding to your inbox</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ul className="relative flex flex-col gap-3">
        {FACTS.map(({ icon: Icon, text }) => (
          <li key={text} className="am-si-fact">
            <span className="am-si-fact-icon">
              <Icon className="size-4" aria-hidden />
            </span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Below lg the panel is hidden; a slim band keeps the story on phones: a masked alias switching on. */
export function SignInBand({ domain }: { domain: string }) {
  return (
    <div aria-hidden className="am-si-band">
      <div className="am-si-aurora">
        <span className="am-si-blob am-si-blob--a" />
        <span className="am-si-blob am-si-blob--b" />
      </div>
      <div className="am-si-grain" />
      <div className="am-si-band-field">
        <Shuffle className="size-3.5 shrink-0 text-[rgb(var(--am-cyan-hi))]" />
        <span className="am-si-mono min-w-0 flex-1 truncate">
          <span className="am-si-typed">{ALIASES[0]}</span>
          <span className="am-si-domain">@{domain}</span>
        </span>
        <span className="am-si-toggle am-si-band-toggle">
          <span className="am-si-knob" />
        </span>
      </div>
    </div>
  );
}
