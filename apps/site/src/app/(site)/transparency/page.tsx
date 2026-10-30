// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { BRAND, PRODUCT_DOMAIN } from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, PageHero, Prose } from "@/components/sections";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Transparency report",
  description: `Requests for user data ${BRAND.product} receives, and how we answer them.`,
  path: "/transparency",
});

const LAST_UPDATED = "2026-10-21";

export default function TransparencyPage() {
  return (
    <>
      <PageHero
        title="Transparency report"
        lead="How many requests for user data we receive, and what we did with them."
        actions={false}
      />
      <section className="am-site-section">
        <div className="am-site-wrap flex flex-col gap-14">
          <Reveal className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-10">
            <h2 className="am-site-h3">Requests so far</h2>
            <Prose>
              <p>
                <strong>No requests received yet.</strong> {BRAND.product} has not launched, so there is nothing to
                report. From launch, we will publish this report every six months, counting requests by type — for
                example court orders, preservation requests and requests from other countries — and how we answered
                them: data disclosed, partially disclosed, or refused.
              </p>
            </Prose>
          </Reveal>
          <Reveal className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-10">
            <h2 className="am-site-h3">How we handle a request</h2>
            <Prose>
              <ul>
                <li>We only act on requests that are legally valid and properly addressed to {BRAND.company}.</li>
                <li>We read each one closely and push back on anything too broad or unclear.</li>
                <li>We disclose the minimum the law requires, and nothing else.</li>
                <li>Where the law allows, we tell the affected person before we disclose anything.</li>
                <li>Mail is stored only for delivering it to you; we do not scan it for advertising or profiling.</li>
              </ul>
              <p>
                The <Link href="/legal/privacy">Privacy Policy</Link> explains what we store and for how long. Questions
                about this report: <a href={`mailto:legal@${PRODUCT_DOMAIN}`}>legal@{PRODUCT_DOMAIN}</a>.
              </p>
            </Prose>
          </Reveal>
          <p className="text-sm text-muted-foreground">Last updated {LAST_UPDATED}.</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
