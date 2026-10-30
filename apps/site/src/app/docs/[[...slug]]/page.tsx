// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
  PageLastUpdate,
} from "fumadocs-ui/layouts/docs/page";

import { JsonLd } from "@/components/json-ld";
import { getMDXComponents } from "@/components/mdx";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { SITE_NAME } from "@/lib/site";
import { REPO_EDIT_BASE, source } from "@/lib/source";

type Props = {
  params: Promise<{ slug?: string[] }>;
};

/** Home › Docs › each parent section that is a page › this page (BreadcrumbList for search results). */
function docsCrumbs(slugs: readonly string[]) {
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Docs", path: "/docs" },
  ];
  for (let i = 1; i <= slugs.length; i++) {
    const p = source.getPage(slugs.slice(0, i));
    if (p) crumbs.push({ name: p.data.title, path: p.url });
  }
  return crumbs;
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const lastModified = page.data.lastModified;
  return (
    <DocsPage toc={page.data.toc}>
      <JsonLd data={breadcrumbJsonLd(docsCrumbs(page.slugs))} />
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description ? <DocsDescription>{page.data.description}</DocsDescription> : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
        <EditOnGitHub href={`${REPO_EDIT_BASE}${page.path}`} />
        {lastModified ? <PageLastUpdate date={lastModified} /> : null}
      </div>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const modified = page.data.lastModified;
  return pageMetadata({
    title: `${page.data.title} · ${SITE_NAME} docs`,
    absoluteTitle: true,
    description: page.data.description ?? `${page.data.title}: a guide to using ${SITE_NAME}.`,
    path: page.url,
    type: "article",
    ...(modified ? { modifiedTime: new Date(modified).toISOString() } : {}),
  });
}
