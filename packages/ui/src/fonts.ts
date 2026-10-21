// SPDX-License-Identifier: AGPL-3.0-only
import localFont from "next/font/local";

/**
 * Brand fonts, all self-hosted — no third-party font requests (privacy requirement). See typography.md.
 *
 * Loading budget (Lighthouse mobile, 2026-10-21): only General Sans Medium (23 KB) is preloaded.
 * - General Sans Medium (Fontshare, ITF Free Font License): display/headings only — headings are always weight 500,
 *   so the Regular/Semibold faces are not shipped. Preloaded, swaps in early (23 KB).
 * - Geist (OFL-1.1, variable, 69 KB): UI/body. NOT preloaded, `display: optional` — a slow first visit keeps the
 *   size-adjusted fallback instead of waiting or re-rendering (no font on the LCP path); later visits get Geist.
 * - Geist Mono (OFL-1.1, variable): labels, numbers, hostnames, DNS values — below the fold, not preloaded.
 */
const generalSans = localFont({
  src: [{ path: "./fonts/GeneralSans-Medium.woff2", weight: "500", style: "normal" }],
  variable: "--font-general-sans",
  display: "swap",
  preload: true,
});

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "optional",
  preload: false,
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Liberation Mono", "monospace"],
});

/** CSS variables for the three brand fonts. Put on <html>. */
export const brandFontVars = [geistSans.variable, geistMono.variable, generalSans.variable].join(" ");
