// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties, ReactNode } from "react";

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Code } from "lucide-react";
import { RootProvider } from "fumadocs-ui/provider/next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Logo } from "@/components/logo";
import { source } from "@/lib/source";

/** Docs share the marketing header/footer; --fd-banner-height keeps the sidebar and TOC below the floating nav. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    // Docs-only provider (search + docs UI); the theme comes from the site-wide ThemeProvider.
    <RootProvider theme={{ enabled: false }}>
      <div className="am-site-below-nav" style={{ "--fd-banner-height": "88px" } as CSSProperties}>
        <SiteHeader />
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: <Logo suffix="Docs" />, url: "/docs" }}
          themeSwitch={{ enabled: false }}
          // A labelled link in the sidebar list: with the theme switch off, the bare icon sat alone in an empty bar.
          links={[
            {
              text: "Source on GitHub",
              url: "https://github.com/anhourtec/anhourmail",
              external: true,
              icon: <Code aria-hidden />,
            },
          ]}
        >
          {children}
        </DocsLayout>
        <SiteFooter />
      </div>
    </RootProvider>
  );
}
