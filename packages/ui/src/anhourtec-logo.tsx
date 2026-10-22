// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

/**
 * The Anhourtec company logo (assets in packages/ui/assets/brand, synced to each app's public/).
 * Picks the light- or dark-background variant with the `dark` class, so it follows the theme without JS.
 */
export function AnhourtecLogo({ className = "h-5 w-auto" }: { className?: string }) {
  return (
    <>
      <img src="/anhourtec-logo-light-bg.svg" alt="Anhourtec" className={`${className} dark:hidden`} />
      <img src="/anhourtec-logo-dark-bg.svg" alt="Anhourtec" className={`${className} hidden dark:block`} />
    </>
  );
}

/** Icons and manifest for Next `metadata` (same files in every app; the SVG favicon follows the OS theme). */
export const BRAND_ICONS: Pick<Metadata, "icons" | "manifest"> = {
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};
