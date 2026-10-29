// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

import {
  ArrowRightIcon,
  AtSignIcon,
  ChevronRightIcon,
  CodeIcon,
  DownloadIcon,
  EyeOffIcon,
  GlobeIcon,
  ImageOffIcon,
  KeyRoundIcon,
  LogOutIcon,
  MailIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  UserPlusIcon,
  VenetianMaskIcon,
  ZapIcon,
} from "lucide-react";

import { ADDONS, ALIASES_PER_MAILBOX, BILLING, PRODUCT_DOMAIN } from "@anhourmail/shared";

import { AliasToggles, DnsChecks, InstantList, TerminalCard, TrackerBlocked } from "@/components/landing/illustrations";
import { WebmailMock } from "@/components/landing/webmail-mock";
import { Reveal } from "@/components/reveal";
import { CtaBand, EssentialsGrid, FaqList, FeatureRow, PlanCards, SectionHead } from "@/components/sections";
import { SIGN_UP_URL } from "@/lib/site";

const LIFECYCLE = [
  { icon: UserPlusIcon, label: "Sign up" },
  { icon: GlobeIcon, label: "Add your domain" },
  { icon: VenetianMaskIcon, label: "Create aliases" },
  { icon: ZapIcon, label: "Read fast" },
  { icon: LogOutIcon, label: "Leave anytime" },
] as const;

const FEATURES = [
  {
    id: "domain",
    href: "/features/custom-domains",
    icon: GlobeIcon,
    eyebrow: "Your domain",
    title: "Bring the address you already own.",
    body: "Guided setup shows every DNS record with a copy button and checks each one live, so you always know what’s left.",
    bullets: ["Records for every major DNS provider", "Live check per record", "Catch-all on paid plans"],
    bloom: "blue",
    art: <DnsChecks />,
  },
  {
    id: "aliases",
    href: "/features/aliases",
    icon: VenetianMaskIcon,
    eyebrow: "Aliases and masked aliases",
    title: "A different address for every sign-up.",
    body: "Give each shop and newsletter its own random address. See which ones get mail, and switch one off the moment it’s sold.",
    bullets: [
      "One-click off switch",
      "A note on each, so you know where you used it",
      `Up to ${String(ALIASES_PER_MAILBOX)} per mailbox on paid plans`,
    ],
    bloom: "violet",
    art: <AliasToggles />,
  },
  {
    id: "fast",
    href: "/features/webmail",
    icon: ZapIcon,
    eyebrow: "Fast webmail",
    title: "Built on JMAP, so it doesn’t wait on IMAP.",
    body: "The webmail syncs only what changed and new mail appears as it arrives. Keyboard shortcuts for everything you do often.",
    bullets: ["Incremental sync and push", "Keyboard-first", "IMAP and SMTP for your other apps"],
    bloom: "cyan",
    art: <InstantList />,
  },
  {
    id: "privacy",
    href: "/features/privacy",
    icon: EyeOffIcon,
    eyebrow: "Private by default",
    title: "Your inbox isn’t a product.",
    body: "No ads and no profiling. Remote images stay blocked until you choose to load them, so tracking pixels never phone home.",
    bullets: [
      "Remote images off by default",
      "No third-party scripts in webmail",
      "This site has no analytics or cookies either",
    ],
    bloom: "green",
    art: <TrackerBlocked />,
  },
  {
    id: "open",
    href: "/about",
    icon: CodeIcon,
    eyebrow: "Open source",
    title: "Read the code. Run it yourself.",
    body: "The webmail, console and this site are open source. The mail server is Stalwart, run unmodified. Self-host it if you’d rather.",
    bullets: ["AGPL-3.0 apps, MIT libraries", "Self-hosting guide", "Public changelog"],
    bloom: "amber",
    art: <TerminalCard />,
  },
] as const;

const SECURITY = [
  { icon: CodeIcon, title: "Open source", body: "Every line that touches your account is public." },
  { icon: EyeOffIcon, title: "No tracking", body: "No ads, no profiling, no analytics in the product." },
  { icon: ImageOffIcon, title: "Remote images blocked", body: "Senders can’t see when you open their mail." },
  { icon: ShieldCheckIcon, title: "Two-step sign-in", body: "Protect the console with an authenticator app." },
  { icon: KeyRoundIcon, title: "App passwords", body: "Mail apps get their own password you can revoke." },
  {
    icon: DownloadIcon,
    title: "Export anytime",
    body: "Take all your mail and contacts with you, in standard formats.",
  },
] as const;

const STEPS = [
  {
    icon: MailIcon,
    title: "Create an account",
    body: "Sign up in the console with your email address. It takes a minute.",
  },
  {
    icon: AtSignIcon,
    title: "Pick your address",
    body: `Take a free @${PRODUCT_DOMAIN} address or connect a domain you own.`,
  },
  {
    icon: SmartphoneIcon,
    title: "Use any app",
    body: "Read mail in the webmail, or in the mail app you already use on your computer or phone.",
  },
] as const;

const FAQ = [
  {
    q: "Is it really free?",
    a: "Yes. Paid plans fund the free tier, and we plan to publish a public cost breakdown.",
  },
  {
    q: "Can I use my own mail app?",
    a: "Yes. IMAP and SMTP work with any standard mail app. App passwords keep your main password private.",
  },
  {
    q: "Can I leave and take my mail with me?",
    a: "Yes. Export all of your mail and contacts at any time, and delete your account whenever you like.",
  },
  {
    q: "Is it open source?",
    a: "Yes. The webmail, console and site are open source. The mail server is Stalwart, run unmodified.",
  },
  {
    q: "Is it end-to-end encrypted?",
    a: "No, and we won’t pretend it is. Mail is encrypted in transit, and we never read it or sell it.",
  },
  {
    q: "Can I send newsletters or bulk mail?",
    a: `Not on the standard plans — they’re for personal mail. ${ADDONS.bulk.name} will be a paid add-on${
      ADDONS.bulk.status === "planned" ? " (coming later)" : ""
    }, sending from a separate pool, only to people who opted in, with one-click unsubscribe.`,
  },
] as const;

export default function HomePage() {
  return (
    <>
      {/* 01 · Hero: animated sky, oversized display, product mock across the seam */}
      <section className="am-site-hero am-site-under-nav">
        <div aria-hidden="true" className="am-site-sky-clip">
          <div className="am-site-sky">
            <span className="am-site-sky-blob am-site-sky-blob--a" />
            <span className="am-site-sky-blob am-site-sky-blob--b" />
            <span className="am-site-sky-blob am-site-sky-blob--c" />
          </div>
          <div className="am-site-sky-scrim" />
          <div className="am-site-sky-grain" />
        </div>

        <div className="relative flex flex-col items-center px-5 pt-[132px] text-center sm:pt-[150px]">
          <Reveal onLoad>
            <Link
              href="/changelog"
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 font-medium text-[12.5px] text-white/85 ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-white/15"
            >
              Building in the open — read the changelog
              <ChevronRightIcon className="size-3.5 opacity-60" aria-hidden="true" />
            </Link>
          </Reveal>
          <Reveal onLoad delayMs={130}>
            <h1 className="am-site-hero-h1 mt-7 max-w-[15ch]">
              Email that minds <em>its own business</em>
            </h1>
          </Reveal>
          <Reveal onLoad delayMs={260}>
            <p className="mx-auto mt-6 max-w-[48ch] text-[clamp(1rem,0.95rem+0.3vw,1.125rem)] text-white/75 leading-relaxed">
              Fast, open-source webmail on your own domain, a fresh alias for every sign-up, and no ads or tracking.
              Ever.
            </p>
          </Reveal>
          <Reveal
            onLoad
            delayMs={390}
            className="mt-9 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row"
          >
            <a href={SIGN_UP_URL} className="am-site-btn am-site-btn--primary h-[52px] w-full px-6 sm:w-auto">
              Get started
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </a>
            <Link href="#how-it-works" className="am-site-btn am-site-btn--glass h-[52px] w-full px-6 sm:w-auto">
              How it works
            </Link>
          </Reveal>
          <Reveal onLoad delayMs={520}>
            <p className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12.5px] text-white/60">
              <span className="inline-flex items-center gap-1.5">
                <CodeIcon className="size-3.5" aria-hidden="true" /> Open source
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <EyeOffIcon className="size-3.5" aria-hidden="true" /> No ads, no tracking
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <DownloadIcon className="size-3.5" aria-hidden="true" /> Export anytime
              </span>
            </p>
          </Reveal>
        </div>

        <div className="relative z-20 mt-14 -mb-[150px] px-4 sm:-mb-[200px] lg:-mb-[240px]">
          <Reveal onLoad delayMs={650} variant="scale" className="mx-auto w-full max-w-[1100px]">
            <div className="am-site-float relative">
              <WebmailMock />
            </div>
          </Reveal>
        </div>
      </section>

      {/* 02 · Seam panel takes the overlap: the essentials as an editorial grid */}
      <section className="am-site-seam px-5 pt-[200px] pb-16 sm:pt-[250px] lg:pt-[300px]">
        <h2 className="sr-only">Highlights</h2>
        <EssentialsGrid />
      </section>

      {/* 03 · Night band with the lifecycle */}
      <section className="px-3 pb-4 sm:px-6">
        <div className="am-site-night mx-auto max-w-[1360px] px-5 py-20 text-center sm:py-24">
          <Reveal>
            <h2 className="am-site-h3 mx-auto max-w-[26ch] text-white">
              Email paid for by subscriptions, not by your attention — from the first message to the last export.
            </h2>
          </Reveal>
          <Reveal className="relative mx-auto mt-12 max-w-[760px]">
            <span aria-hidden="true" className="am-site-lifeline hidden sm:block" />
            <ol className="relative grid grid-cols-2 gap-y-8 sm:grid-cols-5">
              {LIFECYCLE.map((s, i) => (
                <li key={s.label} className="flex flex-col items-center gap-3">
                  <span className="am-site-life-icon" style={{ transitionDelay: `${i * 80}ms` }}>
                    <s.icon className="size-6" aria-hidden="true" />
                  </span>
                  <span className="text-[13px] text-white/70">{s.label}</span>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </section>

      {/* 04 · Feature rows on tinted stages, each linking to its page */}
      <section id="features" className="am-site-section">
        <div className="am-site-wrap-wide">
          <SectionHead title="Everything a private inbox needs, nothing it doesn’t." />
          <div className="mt-20 flex flex-col gap-28 sm:mt-28 sm:gap-36">
            {FEATURES.map((f, i) => (
              <FeatureRow
                key={f.id}
                icon={f.icon}
                label={f.eyebrow}
                title={f.title}
                body={f.body}
                bullets={f.bullets}
                bloom={f.bloom}
                art={f.art}
                flip={i % 2 === 1}
                href={f.href}
              />
            ))}
          </div>
        </div>
      </section>

      {/* 05 · Security panel */}
      <section className="px-3 sm:px-6">
        <Reveal className="am-site-night-gradient mx-auto max-w-[1360px] overflow-hidden px-6 py-20 sm:px-12 sm:py-24">
          <div className="mx-auto flex max-w-[1100px] flex-col gap-12">
            <div className="flex max-w-[40rem] flex-col gap-4">
              <h2 className="am-site-h2 text-white">Built so we can’t make money from your mail.</h2>
              <p className="text-white/70">
                No ad business to feed, nothing to sell. The defaults protect you, and the code is there to check.
              </p>
              <Link href="/security" className="am-site-link-arrow self-start text-[rgb(var(--am-cyan-hi))]">
                How we protect your mail
                <ArrowRightIcon className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {SECURITY.map((s) => (
                <li
                  key={s.title}
                  className="flex flex-col gap-3 rounded-[20px] bg-white/[0.06] p-6 ring-1 ring-white/10"
                >
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-white/10">
                    <s.icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="am-site-h4 text-white">{s.title}</h3>
                  <p className="text-sm text-white/65">{s.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      {/* 06 · How it works */}
      <section id="how-it-works" className="am-site-section">
        <div className="am-site-wrap-wide flex flex-col gap-14">
          <Reveal className="mx-auto flex max-w-[40rem] flex-col items-center gap-4 text-center">
            <h2 className="am-site-h2">Three steps, no migration weekend.</h2>
          </Reveal>
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal
                as="li"
                key={s.title}
                delayMs={i * 120}
                className="am-site-card relative flex flex-col gap-4 overflow-hidden bg-card"
              >
                <span
                  aria-hidden="true"
                  className="absolute top-4 right-5 font-display text-[64px] leading-none text-[rgb(var(--am-btn)/0.1)]"
                >
                  {i + 1}
                </span>
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))]">
                  <s.icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="am-site-h4">{s.title}</h3>
                <p className="text-muted-foreground text-sm">{s.body}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* 07 · Pricing teaser */}
      <section id="pricing" className="am-site-section pt-0">
        <div className="am-site-wrap-wide flex flex-col gap-12">
          <SectionHead
            kicker="Planned pricing"
            title="Start free. Pay yearly when you want more."
            lead={`Billed once a ${BILLING.interval}, with a ${String(BILLING.refundWindowDays)}-day refund window. The free plan is the trial.`}
          />
          <PlanCards />
          <Reveal className="flex justify-center">
            <Link href="/pricing" className="am-site-link-arrow">
              Compare plans and billing details
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Link>
          </Reveal>
        </div>
      </section>

      {/* 08 · FAQ */}
      <section id="faq" className="am-site-section pt-0">
        <div className="am-site-wrap flex flex-col gap-10">
          <SectionHead title="Straight answers." />
          <FaqList items={FAQ} />
        </div>
      </section>

      <CtaBand />
    </>
  );
}
