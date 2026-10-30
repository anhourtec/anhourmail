// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArrowRightIcon } from "lucide-react";

import { FEATURE_ICONS } from "@/components/feature-icons";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { CtaBand, EssentialsGrid, FaqList, FeatureRow, PageHero, SectionHead, Seam } from "@/components/sections";
import { FEATURE_CONTENT } from "@/lib/feature-content";
import { FEATURE_PAGES, type FeatureSlug, featureHref } from "@/lib/ia";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ slug: string }> };

const isSlug = (s: string): s is FeatureSlug => FEATURE_PAGES.some((f) => f.slug === s);

export function generateStaticParams() {
  return FEATURE_PAGES.map((f) => ({ slug: f.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!isSlug(slug)) return {};
  const c = FEATURE_CONTENT[slug];
  return pageMetadata({ title: c.seoTitle, description: c.description, path: featureHref(slug) });
}

export default async function FeaturePage({ params }: Props) {
  const { slug } = await params;
  if (!isSlug(slug)) notFound();
  const c = FEATURE_CONTENT[slug];
  const nav = FEATURE_PAGES.find((f) => f.slug === slug)?.nav ?? c.eyebrow;
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Features", path: "/features" },
          { name: nav, path: featureHref(slug) },
        ])}
      />
      <PageHero crumbs={[{ label: "Features", href: "/features" }, { label: nav }]} title={c.title} lead={c.lead}>
        {c.heroArt}
      </PageHero>
      <Seam />
      <section className="am-site-section pt-10">
        <div className="am-site-wrap-wide flex flex-col gap-28 sm:gap-36">
          {c.rows.map((r, i) => (
            <FeatureRow key={r.title} {...r} flip={i % 2 === 1} />
          ))}
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="flex flex-col gap-12">
          <SectionHead title={c.detailsTitle} />
          <EssentialsGrid items={c.details} />
        </div>
      </section>
      {c.faq.length > 0 ? (
        <section className="am-site-section pt-0">
          <div className="am-site-wrap flex flex-col gap-10">
            <SectionHead title="Questions" />
            <FaqList items={c.faq} />
          </div>
        </section>
      ) : null}
      <section className="am-site-section pt-0">
        <div className="am-site-wrap-wide grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2">
          {c.related.map((r, i) => {
            const f = FEATURE_PAGES.find((x) => x.slug === r);
            if (!f) return null;
            const Icon = FEATURE_ICONS[r];
            return (
              <Reveal key={r} delayMs={i * 100}>
                <Link
                  href={featureHref(r)}
                  className="am-site-card group flex items-center gap-4 bg-card p-6 transition-colors hover:border-[rgb(var(--am-btn)/0.4)]"
                >
                  <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="am-site-h4">{f.title}</span>
                    <span className="truncate text-muted-foreground text-sm">{f.blurb}</span>
                  </span>
                  <ArrowRightIcon
                    className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>
      <CtaBand />
    </>
  );
}
