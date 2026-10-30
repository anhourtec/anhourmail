// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

import { ArrowRightIcon, ChevronDownIcon, MenuIcon } from "lucide-react";

import { FEATURE_PAGES, featureHref } from "@/lib/ia";
import { NAV_LINKS, SIGN_IN_URL, SIGN_UP_URL } from "@/lib/site";

import { FEATURE_ICONS } from "./feature-icons";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/**
 * Floating pill navigation (BookYourPTO pattern), shared by every public page. The Features mega-menu opens on
 * hover and on keyboard focus (focus-within), and the mobile menu is a <details> element — no JavaScript needed.
 */
export function SiteHeader() {
  return (
    <header className="am-site-nav">
      <nav aria-label="Main" className="am-site-nav-pill">
        <Link href="/" aria-label="AnhourMail home" className="am-site-nav-tile shrink-0">
          <Logo onDark />
        </Link>
        <ul className="hidden flex-1 items-center justify-center gap-1 lg:flex">
          <li className="am-site-nav-dd relative">
            <Link href="/features" className="am-site-nav-link" aria-haspopup="true">
              Features
              <ChevronDownIcon className="am-site-nav-dd-chevron size-3.5 opacity-70" aria-hidden="true" />
            </Link>
            <div className="am-site-nav-dd-panel">
              <div className="grid w-[560px] grid-cols-2 gap-1 rounded-[20px] bg-[rgb(var(--am-site-night))] p-2 shadow-[0_2px_40px_rgb(0_0_0/0.35)] ring-1 ring-white/10">
                {FEATURE_PAGES.map((f) => {
                  const Icon = FEATURE_ICONS[f.slug];
                  return (
                    <Link
                      key={f.slug}
                      href={featureHref(f.slug)}
                      className="flex gap-3 rounded-[14px] p-3 transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07]"
                    >
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] text-[rgb(var(--am-cyan-hi))]">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium text-[14px] text-white">{f.nav}</span>
                        <span className="text-[12.5px] text-white/55 leading-snug">{f.blurb}</span>
                      </span>
                    </Link>
                  );
                })}
                <Link
                  href="/docs/features"
                  className="flex items-center justify-between gap-3 rounded-[14px] p-3 text-[13.5px] text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
                >
                  The full feature list
                  <ArrowRightIcon className="size-4" aria-hidden="true" />
                </Link>
                <Link
                  href="/switch"
                  className="flex items-center justify-between gap-3 rounded-[14px] p-3 text-[13.5px] text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
                >
                  Moving from another provider?
                  <ArrowRightIcon className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </li>
          {NAV_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="am-site-nav-link">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          <ThemeToggle onDark />
          <a href={SIGN_IN_URL} className="am-site-nav-link hidden shrink-0 whitespace-nowrap sm:inline-flex">
            Sign in
          </a>
          <a
            href={SIGN_UP_URL}
            className="am-site-btn am-site-btn--primary hidden h-[42px] shrink-0 whitespace-nowrap rounded-[16px] px-4 text-sm sm:inline-flex"
          >
            Get started
          </a>
          <details className="am-site-nav-menu relative lg:hidden">
            <summary className="am-site-nav-link cursor-pointer list-none" aria-label="Menu">
              <MenuIcon className="size-5" aria-hidden="true" />
            </summary>
            <div className="am-site-nav-menu-panel absolute top-[calc(100%+10px)] right-0 max-h-[calc(100dvh-90px)] w-[min(20rem,calc(100vw-24px))] overflow-y-auto rounded-[18px] bg-[rgb(var(--am-site-night))] p-2 shadow-[0_2px_40px_rgb(0_0_0/0.35)] ring-1 ring-white/10">
              <p className="px-3 pt-2 pb-1 text-[11px] text-white/45 uppercase tracking-wider">Features</p>
              {FEATURE_PAGES.map((f) => (
                <Link key={f.slug} href={featureHref(f.slug)} className="am-site-nav-link flex">
                  {f.nav}
                </Link>
              ))}
              <Link href="/docs/features" className="am-site-nav-link flex">
                Full feature list
              </Link>
              <div className="my-2 border-white/10 border-t" />
              {NAV_LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="am-site-nav-link flex">
                  {l.label}
                </Link>
              ))}
              <Link href="/switch" className="am-site-nav-link flex">
                Switch to AnhourMail
              </Link>
              <div className="my-2 border-white/10 border-t" />
              <a href={SIGN_IN_URL} className="am-site-nav-link flex">
                Sign in
              </a>
              <a href={SIGN_UP_URL} className="am-site-nav-link flex text-[rgb(var(--am-cyan-hi))]">
                Get started
              </a>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
