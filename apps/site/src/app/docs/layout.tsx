// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties, ReactNode } from "react";

import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Logo } from "@/components/logo";
import { source } from "@/lib/source";

/** Docs share the marketing header/footer; --fd-banner-height keeps the sidebar and TOC below the floating nav. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="am-site-below-nav" style={{ "--fd-banner-height": "88px" } as CSSProperties}>
      <SiteHeader />
      <DocsLayout
        tree={source.getPageTree()}
        nav={{ title: <Logo suffix="Docs" />, url: "/docs" }}
        themeSwitch={{ enabled: false }}
        githubUrl="https://github.com/anhourtec/anhourmail"
      >
        {children}
      </DocsLayout>
      <SiteFooter />
    </div>
  );
}
