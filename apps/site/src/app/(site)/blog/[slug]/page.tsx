// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArrowLeftIcon } from "lucide-react";

import { getMDXComponents } from "@/components/mdx";
import { CtaBand } from "@/components/sections";
import { blog } from "@/lib/source";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return blog.getPages().map((p) => ({ slug: p.slugs[0] ?? "" }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = blog.getPage([slug]);
  if (!page) return {};
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      publishedTime: page.data.date,
    },
  };
}

const date = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" });

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const page = blog.getPage([slug]);
  if (!page) notFound();
  const Body = page.data.body;
  return (
    <>
      <article className="am-site-wrap am-site-section pt-10">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Blog
        </Link>
        <h1 className="am-site-h1 mt-6 max-w-[22ch]">{page.data.title}</h1>
        <p className="am-small mt-4">
          <time dateTime={page.data.date}>{date.format(new Date(`${page.data.date}T00:00:00Z`))}</time> ·{" "}
          {page.data.author}
        </p>
        <p className="am-site-lead mt-6 max-w-[60ch]">{page.data.description}</p>
        <div className="am-site-legal mt-4">
          <Body components={getMDXComponents()} />
        </div>
      </article>
      <CtaBand />
    </>
  );
}
