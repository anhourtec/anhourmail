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

import { getMDXComponents } from "@/components/mdx";
import { REPO_EDIT_BASE, source } from "@/lib/source";

type Props = {
  params: Promise<{ slug?: string[] }>;
};

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const lastModified = page.data.lastModified;
  return (
    <DocsPage toc={page.data.toc}>
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
  return {
    title: page.data.title,
    ...(page.data.description ? { description: page.data.description } : {}),
    alternates: { canonical: page.url },
  };
}
