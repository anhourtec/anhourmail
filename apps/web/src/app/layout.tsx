// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { BRAND_ICONS } from "@anhourmail/ui/anhourtec-logo";
import { brandFontVars } from "@anhourmail/ui/fonts";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AnhourMail", template: "%s · AnhourMail" },
  robots: { index: false, follow: false },
  ...BRAND_ICONS,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-CA" className={brandFontVars} suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
