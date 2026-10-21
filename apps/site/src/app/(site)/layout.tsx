// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { AttributionCapture } from "@/components/attribution-capture";
import { SiteHeader } from "@/components/site-header";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AttributionCapture />
      <SiteHeader />
      <main id="main" className="am-site-below-nav flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
