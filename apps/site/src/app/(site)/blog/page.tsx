// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRightIcon } from "lucide-react";

import { Reveal } from "@/components/reveal";
import { CtaBand, PageHero } from "@/components/sections";
import { blogIndex } from "@/lib/source";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Blog",
  description: "Notes from the people building AnhourMail: why we make the choices we do.",
  path: "/blog",
});

const date = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" });

export default function BlogIndexPage() {
  const posts = blogIndex();
  return (
    <>
      <PageHero
        title="Blog"
        lead="Why we build AnhourMail the way we do. Release notes live in the changelog."
        actions={false}
      />
      <section className="am-site-section">
        <ul className="am-site-wrap flex flex-col divide-y border-y">
          {posts.map((p, i) => (
            <Reveal as="li" key={p.url} delayMs={i * 80}>
              <Link
                href={p.url}
                className="group grid grid-cols-[minmax(0,1fr)] gap-2 py-8 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-baseline md:gap-8"
              >
                <time dateTime={p.data.date} className="am-num text-muted-foreground text-sm">
                  {date.format(new Date(`${p.data.date}T00:00:00Z`))}
                </time>
                <span className="flex flex-col gap-2">
                  <span className="am-site-h3 transition-colors group-hover:text-[rgb(var(--am-btn))]">
                    {p.data.title}
                  </span>
                  <span className="text-muted-foreground">{p.data.description}</span>
                </span>
                <ArrowRightIcon
                  className="hidden size-5 text-muted-foreground transition-transform group-hover:translate-x-1 md:block"
                  aria-hidden="true"
                />
              </Link>
            </Reveal>
          ))}
        </ul>
      </section>
      <CtaBand />
    </>
  );
}
