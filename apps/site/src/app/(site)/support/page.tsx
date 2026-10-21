// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ActivityIcon, BookOpenIcon, BugIcon, LifeBuoyIcon, ShieldAlertIcon, ShieldIcon } from "lucide-react";

import { PRODUCT_DOMAIN } from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, PageHero } from "@/components/sections";
import { LEGAL_CONTACTS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with AnhourMail: documentation, contact addresses for support, abuse and security, and service status.",
  alternates: { canonical: "/support" },
  openGraph: { title: "Support · AnhourMail", url: "/support" },
};

const mail = (addr: string) => (
  <a href={`mailto:${addr}`} className="font-mono text-[13px] underline underline-offset-2">
    {addr}
  </a>
);

const CARDS: readonly { icon: typeof LifeBuoyIcon; title: string; body: ReactNode }[] = [
  {
    icon: BookOpenIcon,
    title: "Documentation",
    body: (
      <>
        Setup guides, mail app settings and answers to common questions in the{" "}
        <Link href="/docs" className="underline underline-offset-2">
          docs
        </Link>
        .
      </>
    ),
  },
  {
    icon: LifeBuoyIcon,
    title: "Help with your account",
    body: <>Write to {mail(LEGAL_CONTACTS.support)}. We answer every message.</>,
  },
  {
    icon: ShieldAlertIcon,
    title: "Report abuse",
    body: <>Spam or phishing from an AnhourMail address? Forward it with headers to {mail(LEGAL_CONTACTS.abuse)}.</>,
  },
  {
    icon: ShieldIcon,
    title: "Security issues",
    body: <>Report vulnerabilities privately to {mail(`security@${PRODUCT_DOMAIN}`)}.</>,
  },
  {
    icon: BugIcon,
    title: "Bugs and ideas",
    body: (
      <>
        Open an issue on{" "}
        <a href="https://github.com/anhourtec/anhourmail/issues" className="underline underline-offset-2">
          GitHub
        </a>{" "}
        — the code is public.
      </>
    ),
  },
  { icon: ActivityIcon, title: "Service status", body: "A public status page goes live with the beta." },
];

export default function SupportPage() {
  return (
    <>
      <PageHero
        title="How can we help?"
        lead="Real people read every message. Start with the docs, or write to us."
        actions={false}
      />
      <section className="am-site-section">
        <ul className="am-site-wrap-wide grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c, i) => (
            <Reveal
              as="li"
              key={c.title}
              delayMs={(i % 3) * 90}
              className="am-site-card flex flex-col gap-3 bg-card p-7"
            >
              <span className="inline-flex size-11 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
                <c.icon className="size-5" aria-hidden="true" />
              </span>
              <h2 className="am-site-h4">{c.title}</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">{c.body}</p>
            </Reveal>
          ))}
        </ul>
      </section>
      <CtaBand />
    </>
  );
}
