// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type RefObject, useEffect, useState } from "react";

/**
 * Choreography for the sign-in brand panel (~12 s per loop):
 *   1 scan the incoming message → 2 tracker blocked → 3 remote images held back →
 *   4 type a masked alias → 5 switch it on → 6 hold, then start again with a new alias.
 * The first render (server and client) is the finished frame, so nothing shifts and reduced-motion users
 * simply keep it. Timers stop while the tab is hidden or the panel is off-screen.
 */
export const ALIASES = ["k7q2mxa9wd", "p3vz8hn1rt", "x9c4lm2qe7"] as const;

export type LoopState = { step: number; typed: string; cycle: number };

export const FINAL_FRAME: LoopState = { step: 6, typed: ALIASES[0], cycle: 0 };

const TYPE_MS = 55;
const CYCLE_MS = 12_000;
const FIRST_HOLD_MS = 2_400;

export function usePrivacyLoop(root: RefObject<HTMLElement | null>): LoopState {
  const [state, setState] = useState<LoopState>(FINAL_FRAME);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let timers: number[] = [];
    let running = false;
    let onScreen = false;
    let cycle = 0;
    const at = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };
    const clear = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = [];
    };

    const runCycle = () => {
      const alias = ALIASES[cycle % ALIASES.length] ?? ALIASES[0];
      const c = cycle;
      setState({ step: 0, typed: "", cycle: c });
      at(500, () => {
        setState({ step: 1, typed: "", cycle: c });
      });
      at(2_300, () => {
        setState({ step: 2, typed: "", cycle: c });
      });
      at(3_500, () => {
        setState({ step: 3, typed: "", cycle: c });
      });
      for (let i = 1; i <= alias.length; i++) {
        at(4_900 + i * TYPE_MS, () => {
          setState({ step: 4, typed: alias.slice(0, i), cycle: c });
        });
      }
      at(6_400, () => {
        setState({ step: 5, typed: alias, cycle: c });
      });
      at(7_200, () => {
        setState({ step: 6, typed: alias, cycle: c });
      });
      at(CYCLE_MS, () => {
        cycle += 1;
        runCycle();
      });
    };

    const sync = () => {
      const shouldRun = onScreen && !document.hidden;
      if (shouldRun && !running) {
        running = true;
        at(FIRST_HOLD_MS, runCycle);
      } else if (!shouldRun && running) {
        running = false;
        clear();
      }
    };

    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? false;
      sync();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      clear();
    };
  }, [root]);

  return state;
}
