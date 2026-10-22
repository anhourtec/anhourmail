// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { ArrowLeft, Code } from "lucide-react";
import { RootProvider } from "fumadocs-ui/provider/next";
import Link from "next/link";

import { SiteFooter } from "@/components/site-footer";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { source } from "@/lib/source";

/**
 * Docs have their own chrome: no marketing nav on top, so the sidebar starts at the top of the page. The sidebar
 * footer carries the way back to the site and the theme switch the marketing nav used to provide.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    // Docs-only provider (search + docs UI); the theme comes from the site-wide ThemeProvider.
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{ title: <Logo suffix="Docs" />, url: "/docs" }}
        themeSwitch={{ enabled: false }}
        // A labelled link in the sidebar list: a bare icon would sit alone in an empty bar.
        links={[
          {
            text: "Source on GitHub",
            url: "https://github.com/anhourtec/anhourmail",
            external: true,
            icon: <Code aria-hidden />,
          },
        ]}
        sidebar={{
          footer: (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-[13px] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                anhourmail.com
              </Link>
              <ThemeToggle />
            </div>
          ),
        }}
      >
        {children}
      </DocsLayout>
      <SiteFooter />
    </RootProvider>
  );
}
