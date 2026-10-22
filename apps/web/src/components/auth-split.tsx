// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { parsePlatformDomain, platformFacts } from "@anhourmail/shared/platform";

import { BrandMark } from "./brand-mark";
import { SignInBand, SignInVisual } from "./sign-in-visual";
import { ThemeToggle } from "./theme-toggle";

/** Shared frame for sign-in and sign-up: form column + brand panel (hidden under lg). `area` names the product area. */
export function AuthSplit({ children, area }: { children: ReactNode; area?: string }) {
  // Read per request like SITE_URL below: the deployment's free address domain, never the product's (rule 32 note in
  // docs/internal/01-architecture.md "Platform hostnames").
  const domain = platformFacts(parsePlatformDomain(process.env.PLATFORM_DOMAIN)).freeAddressDomain;
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <main className="flex flex-col gap-6 px-4 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <BrandMark {...(area ? { area } : {})} />
          <ThemeToggle />
        </div>
        <div className="lg:hidden">
          <SignInBand domain={domain} />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 pb-12 lg:py-12">
          {children}
        </div>
      </main>
      <aside className="hidden p-3 lg:block">
        <div className="h-full overflow-hidden rounded-2xl">
          <SignInVisual domain={domain} />
        </div>
      </aside>
    </div>
  );
}

/** "By signing in/up, you agree to…" with links to the legal pages on the marketing site. */
export function LegalConsent({ verb }: { verb: "signing in" | "creating an account" }) {
  const siteUrl = (process.env.SITE_URL ?? "https://anhourmail.com").replace(/\/$/, "");
  return (
    <p className="am-micro">
      By {verb}, you agree to our{" "}
      <a href={`${siteUrl}/legal/terms`} className="underline underline-offset-2 hover:text-foreground">
        Terms of Service
      </a>{" "}
      and{" "}
      <a href={`${siteUrl}/legal/privacy`} className="underline underline-offset-2 hover:text-foreground">
        Privacy Policy
      </a>
      .
    </p>
  );
}
