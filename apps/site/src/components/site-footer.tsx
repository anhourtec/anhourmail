// SPDX-License-Identifier: AGPL-3.0-only
import Image from "next/image";
import Link from "next/link";

import { ArrowRightIcon, ArrowUpRightIcon, CodeIcon } from "lucide-react";

import { BRAND } from "@anhourmail/shared";

import { FEATURE_PAGES, featureHref } from "@/lib/ia";

import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

const REPO = "https://github.com/anhourtec/anhourmail";

type FooterLink = { label: string; href?: string; external?: boolean; soon?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/features" },
      ...FEATURE_PAGES.slice(0, 3).map((f) => ({ label: f.nav, href: featureHref(f.slug) })),
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Blog", href: "/blog" },
      { label: "Changelog", href: "/changelog" },
      { label: "Support", href: "/support" },
      { label: "Switch to AnhourMail", href: "/switch" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Mail app settings", href: "/docs/clients/imap-smtp-settings" },
      { label: "Self-hosting", href: "/docs/self-hosting" },
      { label: "Source code", href: REPO, external: true },
      { label: "Credits", href: "/credits" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/legal/terms" },
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Acceptable use", href: "/legal/acceptable-use" },
    ],
  },
];

const linkClass = "inline-flex items-center gap-1 text-[14px] text-white/60 transition-colors hover:text-white";

/**
 * Footer shared by every public page (BookYourPTO pattern): a full-bleed night band, so the page ends on the
 * same dark note as the final call to action. Always dark, in both themes.
 */
export function SiteFooter() {
  return (
    <footer className="relative z-10 mt-auto overflow-hidden rounded-t-[40px] bg-[rgb(var(--am-site-night-deep))] text-white shadow-[0_-1px_0_rgb(255_255_255/0.06)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[70rem] max-w-[160vw] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--am-btn)/0.28),transparent)]"
      />
      <div className="am-site-wrap-wide relative pt-20 pb-10 lg:pt-24">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)] lg:gap-10">
          <div className="flex flex-col items-start gap-5">
            <Link href="/" aria-label="AnhourMail home" className="inline-flex items-center gap-2.5">
              <Logo className="[&>span:first-child]:text-[18px]" />
            </Link>
            <p className="max-w-[34ch] text-[15px] leading-relaxed text-white/60">
              Private, fast email on your own domain. Open source, with no ads and no tracking.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <Link href="/#waitlist" className="am-site-btn am-site-btn--primary h-10 px-4 text-sm">
                Join the waitlist
                <ArrowRightIcon className="size-4" aria-hidden="true" />
              </Link>
              <a href={REPO} className="am-site-btn am-site-btn--glass h-10 px-4 text-sm ring-1 ring-white/10">
                <CodeIcon className="size-4" aria-hidden="true" />
                Read the code
              </a>
            </div>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
            {COLUMNS.map((col) => (
              <div key={col.title} className="flex flex-col gap-4">
                <h2 className="font-display text-[14px] font-medium tracking-[-0.01em] text-white">{col.title}</h2>
                <ul className="flex flex-col gap-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      {l.soon || !l.href ? (
                        <span className="inline-flex items-center gap-2 text-[14px] text-white/35">
                          {l.label}
                          <span className="rounded-full bg-white/[0.07] px-1.5 py-px text-[10px] uppercase tracking-wider text-white/45">
                            Soon
                          </span>
                        </span>
                      ) : l.external ? (
                        <a href={l.href} className={linkClass}>
                          {l.label}
                          <ArrowUpRightIcon className="size-3.5 opacity-60" aria-hidden="true" />
                        </a>
                      ) : (
                        <Link href={l.href} className={linkClass}>
                          {l.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-16 flex flex-col gap-6 border-white/[0.08] border-t pt-7 md:flex-row md:items-center md:justify-between">
          <p className="text-[12.5px] text-white/45">
            © {new Date().getFullYear()} {BRAND.company}. No ads, no tracking, no cookies on this site.
          </p>
          <div className="flex flex-wrap items-center gap-5">
            <ThemeToggle onDark />
            <a
              href="https://anhourtec.com"
              className="inline-flex items-center gap-2.5 text-[12.5px] text-white/50 transition-colors hover:text-white/80"
            >
              Made by
              <Image
                src="/anhourtec-logo-dark-bg.svg"
                alt="Anhourtec"
                width={79}
                height={24}
                unoptimized
                className="h-6 w-auto opacity-90"
              />
            </a>
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none select-none overflow-hidden px-4 text-center font-display font-medium uppercase leading-[0.78] tracking-[0.08em]"
      >
        <span className="block translate-y-[18%] bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] bg-clip-text text-[clamp(2.5rem,11.5vw,10.5rem)] text-transparent">
          {BRAND.product}
        </span>
      </div>
    </footer>
  );
}
