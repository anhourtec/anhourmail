// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { BRAND, PLANS } from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, PageHero, Prose } from "@/components/sections";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Where the money goes",
  description: `What a ${BRAND.product} subscription pays for. Real numbers are published once we launch.`,
  path: "/costs",
});

const CATEGORIES = [
  { title: "Servers", body: "The machines that receive, store and send your mail, and run the webmail." },
  { title: "Storage", body: "Disk for every mailbox, with room to grow, plus the space backups need." },
  { title: "Backups", body: "Encrypted copies kept away from the main servers, and the time to test restoring them." },
  { title: "Payment fees", body: "Card processors take a fixed fee plus a percentage of every payment." },
  {
    title: "Support and safety",
    body: "People to answer questions, handle abuse reports and keep sending reputation clean.",
  },
  {
    title: "The free plan",
    body: `Paid plans fund the ${PLANS.free.name} plan. There are no ads or data deals to pay for it.`,
  },
] as const;

export default function CostsPage() {
  return (
    <>
      <PageHero
        title="Where the money goes"
        lead="Your subscription is the whole business model. Here is what it pays for."
        actions={false}
      />
      <section className="am-site-section">
        <div className="am-site-wrap flex flex-col gap-12">
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
            {CATEGORIES.map((c) => (
              <Reveal as="li" key={c.title} className="flex flex-col gap-2 border-t pt-5">
                <h2 className="am-site-h4">{c.title}</h2>
                <p className="text-muted-foreground">{c.body}</p>
              </Reveal>
            ))}
          </ul>
          <Prose>
            <p>
              <strong>Numbers are published once we launch.</strong> We will post the real monthly costs here, by
              category, so you can check that prices are fair. See the plans on the{" "}
              <Link href="/pricing">pricing page</Link>.
            </p>
          </Prose>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
