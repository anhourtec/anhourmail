// SPDX-License-Identifier: AGPL-3.0-only
import localFont from "next/font/local";

import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

/**
 * Brand fonts, all self-hosted — no third-party font requests (privacy requirement).
 * General Sans (Fontshare, ITF Free Font License) is display/headings only; Geist is UI/body; Geist Mono is
 * labels, numbers, hostnames and DNS values. See docs/internal/typography.md.
 */
const generalSans = localFont({
  src: [
    { path: "./fonts/GeneralSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/GeneralSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/GeneralSans-Semibold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-general-sans",
  display: "swap",
});

/** CSS variables for the three brand fonts. Put on <body>. */
export const brandFontVars = [GeistSans.variable, GeistMono.variable, generalSans.variable].join(" ");
