// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRightIcon, FileTextIcon } from "lucide-react";

import { LEGAL_PAGES } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Legal",
  description: "Terms of Service, Privacy Policy and Acceptable Use Policy for AnhourMail. Drafts under legal review.",
  alternates: { canonical: "/legal" },
};

export default function LegalIndexPage() {
  return (
    <div className="am-site-wrap am-site-section pt-10">
      <div className="flex flex-col items-start gap-4">
        <h1 className="am-site-h1">The fine print, in plain words</h1>
        <p className="am-site-lead max-w-[56ch]">
          These are drafts while AnhourMail is in development — not yet in effect, and under legal review.
        </p>
      </div>
      <ul className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
        {LEGAL_PAGES.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              className="am-site-card group flex h-full flex-col gap-3 bg-card transition-colors hover:border-[rgb(var(--am-btn)/0.4)]"
            >
              <FileTextIcon className="size-5 text-[rgb(var(--am-btn))]" aria-hidden="true" />
              <span className="am-site-h4">{p.title}</span>
              <span className="flex-1 text-muted-foreground text-sm">{p.summary}</span>
              <span className="inline-flex items-center gap-1 text-sm text-[rgb(var(--am-ink-accent))] dark:text-[rgb(var(--am-cyan-hi))]">
                Read
                <ArrowRightIcon
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
