// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = { title: "Webmail" };

/**
 * Webmail origin (mail.*). Phase 4 builds the JMAP client here (docs/internal/05-webmail.md); sign-in on this
 * origin uses a one-time handoff from the console, never a shared cookie (ADR-0003).
 */
export default function WebmailPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-4">
      <div className="flex items-center justify-between">
        <BrandMark area="Webmail" />
        <ThemeToggle />
      </div>
      <h1 className="am-h1">Webmail is on its way</h1>
      <p className="am-lead">
        The fast JMAP webmail lands in phase 4. Until then, use any IMAP mail app with an app password.
      </p>
    </main>
  );
}
