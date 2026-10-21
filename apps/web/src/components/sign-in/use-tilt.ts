// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { PointerEvent, RefObject } from "react";

const MAX_DEG = 7;

/**
 * Pointer-following tilt for the card stack: writes two CSS variables in a rAF (transform only, clamped).
 * Off under reduced motion and for touch pointers.
 */
export function useTilt(stack: RefObject<HTMLElement | null>) {
  let frame = 0;

  const set = (x: number, y: number) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      stack.current?.style.setProperty("--am-si-ry", `${x.toFixed(2)}deg`);
      stack.current?.style.setProperty("--am-si-rx", `${y.toFixed(2)}deg`);
    });
  };

  return {
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const r = e.currentTarget.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      set(Math.max(-1, Math.min(1, nx * 2)) * MAX_DEG, Math.max(-1, Math.min(1, -ny * 2)) * MAX_DEG);
    },
    onPointerLeave: () => {
      set(0, 0);
    },
  };
}
