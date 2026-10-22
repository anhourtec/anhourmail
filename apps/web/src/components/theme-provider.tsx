// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ThemeProvider as NextThemes } from "next-themes";

export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string | undefined }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce ? { nonce } : {})}
    >
      {children}
    </NextThemes>
  );
}
