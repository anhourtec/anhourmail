// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { BRAND, PLANS } from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, PageHero, Prose } from "@/components/sections";

export const metadata: Metadata = {
  title: "About",
  description: `Why ${BRAND.company} is building ${BRAND.product}: private, fast, open-source email funded by subscriptions.`,
  alternates: { canonical: "/about" },
  openGraph: { title: "About · AnhourMail", url: "/about" },
};

const BLOCKS = [
  {
    title: "Why we’re building it",
    body: (
      <>
        <p>
          {BRAND.company} built a webmail before, called HourMail. It worked, but it was slow: every click went through
          the old IMAP protocol. {BRAND.product} starts again on JMAP, the modern mail protocol, so the webmail only
          fetches what changed and new mail shows up as it arrives.
        </p>
        <p>
          We also wanted the rest done right: your own domain without a fight, an address for every sign-up, and no
          business model that depends on reading your mail.
        </p>
      </>
    ),
  },
  {
    title: "How the free plan is paid for",
    body: (
      <p>
        Paid plans — {PLANS.plus.name} and {PLANS.supporter.name} — fund the service, including the free plan. There are
        no ads and no data deals. We plan to publish a public breakdown of what running {BRAND.product} costs, so you
        can see where the money goes.
      </p>
    ),
  },
  {
    title: "Open source, with a clear licence",
    body: (
      <>
        <p>
          The apps — webmail, console and this site — are open source under the AGPL-3.0 licence. Our reusable libraries
          are MIT. Anyone can read the code, report issues or run it themselves; see the{" "}
          <Link href="/docs/self-hosting">self-hosting guide</Link>.
        </p>
        <p>
          The mail server is Stalwart, run unmodified under its AGPL-3.0 licence. The{" "}
          <Link href="/credits">credits page</Link> lists every open-source project we build on.
        </p>
      </>
    ),
  },
  {
    title: `Who is ${BRAND.company}`,
    body: (
      <p>
        {BRAND.company} is a small, independent software company. {BRAND.product} is our own product, built in the open
        — follow along in the <Link href="/changelog">changelog</Link> and on the <Link href="/blog">blog</Link>.
      </p>
    ),
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        title="Email you don’t have to think about"
        lead={`${BRAND.product} is made by ${BRAND.company}. We think private, fast email should be ordinary, not a luxury.`}
        actions={false}
      />
      <section className="am-site-section">
        <div className="am-site-wrap flex flex-col gap-16">
          {BLOCKS.map((b, i) => (
            <Reveal
              key={b.title}
              className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-10"
            >
              <div className="flex flex-col gap-2">
                <span className="am-num text-muted-foreground text-sm">{String(i + 1).padStart(2, "0")}</span>
                <h2 className="am-site-h3">{b.title}</h2>
              </div>
              <Prose>{b.body}</Prose>
            </Reveal>
          ))}
        </div>
      </section>
      <CtaBand />
    </>
  );
}
