// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { BRAND_ICONS } from "@anhourmail/ui/anhourtec-logo";
import { brandFontVars } from "@anhourmail/ui/fonts";

import { ThemeProvider } from "@/components/theme-provider";
import { HOME_TITLE, OG_IMAGE } from "@/lib/seo";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

import "./globals.css";

/**
 * Site-wide defaults. Each page sets its own title, description, canonical URL and share tags through
 * `pageMetadata` (lib/seo.ts); these cover anything that doesn't (the 404 page). No canonical here: a page without
 * one must not claim to be the home page.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: { default: HOME_TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: { card: "summary_large_image", images: [OG_IMAGE.url] },
  robots: { index: true, follow: true, googleBot: { "max-image-preview": "large", "max-snippet": -1 } },
  ...BRAND_ICONS,
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#070d18" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Set by src/proxy.ts on every page (nonce CSP); the theme script must carry it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={brandFontVars} suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col">
        <noscript>
          <style>{".am-site-reveal{opacity:1;transform:none}"}</style>
        </noscript>
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
