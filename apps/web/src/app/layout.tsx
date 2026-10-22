// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";

import { BRAND_ICONS } from "@anhourmail/ui/anhourtec-logo";
import { brandFontVars } from "@anhourmail/ui/fonts";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AnhourMail", template: "%s · AnhourMail" },
  robots: { index: false, follow: false },
  ...BRAND_ICONS,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set by src/proxy.ts on webmail pages (nonce CSP); the theme script must carry it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en-CA" className={brandFontVars} suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
