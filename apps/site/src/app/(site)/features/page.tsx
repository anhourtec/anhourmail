// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRightIcon } from "lucide-react";

import { FEATURE_ICONS } from "@/components/feature-icons";
import { Reveal } from "@/components/reveal";
import { CtaBand, EssentialsGrid, SectionHead, PageHero } from "@/components/sections";
import { FEATURE_PAGES, featureHref } from "@/lib/ia";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Everything in AnhourMail: your own domain, aliases and masked aliases, fast JMAP webmail, privacy by default and every mail app.",
  alternates: { canonical: "/features" },
  openGraph: { title: "Features · AnhourMail", url: "/features" },
};

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        title="Everything a private inbox needs"
        lead="Your own domain, an address for every sign-up, webmail that keeps up with you — and nothing watching over your shoulder."
      />
      <section className="am-site-section">
        <div className="am-site-wrap-wide flex flex-col gap-14">
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 lg:grid-cols-3">
            {FEATURE_PAGES.map((f, i) => {
              const Icon = FEATURE_ICONS[f.slug];
              return (
                <Reveal as="li" key={f.slug} delayMs={(i % 3) * 100}>
                  <Link
                    href={featureHref(f.slug)}
                    className="am-site-card group flex h-full flex-col gap-4 bg-card p-7 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-[rgb(var(--am-btn)/0.4)]"
                  >
                    <span className="inline-flex size-11 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <h2 className="am-site-h4">{f.title}</h2>
                    <p className="flex-1 text-muted-foreground text-sm">{f.blurb}</p>
                    <span className="am-site-link-arrow text-sm">
                      Learn more<span className="sr-only"> about {f.title}</span>
                      <ArrowRightIcon className="size-4" aria-hidden="true" />
                    </span>
                  </Link>
                </Reveal>
              );
            })}
            <Reveal as="li" delayMs={200}>
              <Link
                href="/switch"
                className="am-site-card flex h-full flex-col justify-center gap-3 border-dashed bg-transparent p-7 transition-colors hover:border-[rgb(var(--am-btn)/0.4)]"
              >
                <h2 className="am-site-h4">Moving from another provider?</h2>
                <p className="text-muted-foreground text-sm">How to bring your address and your mail with you.</p>
                <span className="am-site-link-arrow text-sm">
                  Switching guide
                  <ArrowRightIcon className="size-4" aria-hidden="true" />
                </span>
              </Link>
            </Reveal>
          </ul>
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="flex flex-col gap-12">
          <SectionHead title="The essentials, on every plan." />
          <EssentialsGrid />
        </div>
      </section>
      <CtaBand />
    </>
  );
}
