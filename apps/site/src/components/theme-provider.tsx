// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ThemeProvider as NextThemes } from "next-themes";
import type { ReactNode } from "react";

/**
 * Light / Dark / System for every page (class on <html>). Deliberately tiny: the docs framework's provider (search,
 * docs UI) is mounted only under /docs, so marketing pages don't download it (Lighthouse mobile).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemes>
  );
}
