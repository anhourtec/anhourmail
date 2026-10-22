// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRightLeftIcon, DownloadIcon, ForwardIcon, GlobeIcon, InboxIcon, MailCheckIcon } from "lucide-react";

import { BRAND, PRODUCT_DOMAIN } from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, EssentialsGrid, PageHero, Prose, SectionHead } from "@/components/sections";

export const metadata: Metadata = {
  title: "Switch to AnhourMail",
  description:
    "Moving from another provider: forward your mail now, bring your domain, and import old mail when the import tool arrives.",
  alternates: { canonical: "/switch" },
  openGraph: { title: "Switch to AnhourMail", url: "/switch" },
};

const STEPS = [
  {
    icon: InboxIcon,
    title: "Get your new address",
    body: `Create an account, then take a free @${PRODUCT_DOMAIN} address or connect a domain you own.`,
  },
  {
    icon: ForwardIcon,
    title: "Forward your old mail",
    body: "Turn on forwarding at your old provider so new mail lands in your new inbox while you move.",
  },
  {
    icon: MailCheckIcon,
    title: "Update your accounts",
    body: "Change the address on the sites that matter. A masked alias per site makes the next move easier.",
  },
  {
    icon: DownloadIcon,
    title: "Bring your old mail",
    body: `A built-in import tool that copies mail from your old provider is coming. Until then your old mail stays where it is, and you can keep reading it there.`,
  },
] as const;

export default function SwitchPage() {
  return (
    <>
      <PageHero
        title="Moving your email, without the weekend"
        lead={`Leaving another provider for ${BRAND.product} is mostly waiting for mail to arrive in the new place. Here’s the order that works.`}
      />
      <section className="am-site-section">
        <ol className="am-site-wrap-wide grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <Reveal
              as="li"
              key={s.title}
              delayMs={i * 100}
              className="am-site-card relative flex flex-col gap-4 overflow-hidden bg-card p-7"
            >
              <span
                aria-hidden="true"
                className="absolute top-4 right-5 font-display text-[56px] leading-none text-[rgb(var(--am-btn)/0.1)]"
              >
                {i + 1}
              </span>
              <span className="inline-flex size-11 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
                <s.icon className="size-5" aria-hidden="true" />
              </span>
              <h2 className="am-site-h4">{s.title}</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">{s.body}</p>
            </Reveal>
          ))}
        </ol>
      </section>
      <section className="am-site-section pt-0">
        <div className="am-site-wrap grid grid-cols-[minmax(0,1fr)] gap-12 md:grid-cols-2">
          <Reveal className="flex flex-col gap-3">
            <h2 className="am-site-h3">Forwarding from Gmail</h2>
            <Prose>
              <p>
                In Gmail’s settings, open <strong>Forwarding and POP/IMAP</strong>, add your new address, confirm it,
                and choose to forward a copy of incoming mail.
              </p>
            </Prose>
          </Reveal>
          <Reveal className="flex flex-col gap-3" delayMs={100}>
            <h2 className="am-site-h3">Forwarding from Outlook</h2>
            <Prose>
              <p>
                In Outlook’s settings, open <strong>Mail → Forwarding</strong>, turn forwarding on and enter your new
                address. Keep a copy if you want to read old threads there.
              </p>
            </Prose>
          </Reveal>
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="flex flex-col gap-12">
          <SectionHead
            title="Bringing a domain you already use?"
            lead="Point it at us when you’re ready — your address doesn’t change."
          />
          <EssentialsGrid
            items={[
              {
                icon: GlobeIcon,
                title: "Keep the domain",
                body: "It stays with your registrar. You only change DNS records.",
              },
              {
                icon: ArrowRightLeftIcon,
                title: "Switch over in one step",
                body: "Mail starts arriving here once the MX record points to us.",
              },
              { icon: MailCheckIcon, title: "Live checks", body: "Each record shows green when it’s right." },
              {
                icon: DownloadIcon,
                title: "Leave anytime",
                body: "Export everything and point the domain elsewhere — no lock-in.",
              },
            ]}
          />
          <Reveal className="flex justify-center">
            <Link href="/docs/custom-domain" className="am-site-link-arrow">
              Read the custom domain guide
            </Link>
          </Reveal>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
