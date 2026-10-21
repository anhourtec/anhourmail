// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

let observer: IntersectionObserver | null = null;

/** One shared observer for every reveal on the page (useRevealObserver pattern). */
function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.setAttribute("data-revealed", "");
          observer?.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  return observer;
}

/**
 * Fades content up (or scales it in) when it scrolls into view. `onLoad` reveals on mount, for the hero.
 * Children can hang their own animations off `[data-revealed]` (site.css). Off under prefers-reduced-motion,
 * and visible without JavaScript via the <noscript> style in the root layout.
 */
export function Reveal({
  children,
  delayMs = 0,
  className,
  variant = "slide",
  onLoad = false,
  as: Tag = "div",
  style,
}: {
  children: ReactNode;
  delayMs?: number;
  className?: string;
  variant?: "slide" | "scale";
  onLoad?: boolean;
  as?: "div" | "li" | "section";
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (onLoad) {
      const raf = requestAnimationFrame(() => {
        el.setAttribute("data-revealed", "");
      });
      return () => {
        cancelAnimationFrame(raf);
      };
    }
    const obs = sharedObserver();
    obs.observe(el);
    return () => {
      obs.unobserve(el);
    };
  }, [onLoad]);
  const cls = `am-site-reveal ${variant === "scale" ? "am-site-reveal--scale" : ""} ${className ?? ""}`;
  return (
    <Tag ref={ref as never} className={cls} style={{ transitionDelay: `${delayMs}ms`, ...style }}>
      {children}
    </Tag>
  );
}
