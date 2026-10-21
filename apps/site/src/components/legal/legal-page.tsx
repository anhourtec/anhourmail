// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import type { ReactNode } from "react";

import { FileWarningIcon } from "lucide-react";

import { LEGAL_PAGES, LEGAL_UPDATED } from "@/lib/legal";

export type LegalSection = { id: string; title: string; body: ReactNode };

const updated = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" }).format(
  new Date(`${LEGAL_UPDATED}T00:00:00Z`),
);

/**
 * Layout for a legal page: draft banner, title, contents list, numbered sections. The draft banner stays
 * until counsel signs the text off (docs/internal/research/market-and-legal.md).
 */
export function LegalPage({
  title,
  lead,
  sections,
}: {
  title: string;
  lead: ReactNode;
  sections: readonly LegalSection[];
}) {
  return (
    <div className="am-site-wrap-wide am-site-section pt-10">
      <div
        role="note"
        className="mb-10 flex items-start gap-3 rounded-[18px] border border-[rgb(var(--am-status-warning-bg)/0.35)] bg-[rgb(var(--am-status-warning-bg)/0.1)] px-5 py-4 text-[14px]"
      >
        <FileWarningIcon className="mt-0.5 size-4 shrink-0 text-[rgb(var(--am-status-warning))]" aria-hidden="true" />
        <p>
          <strong className="font-medium">Draft — not yet in effect; under legal review.</strong>{" "}
          <span className="text-muted-foreground">
            AnhourMail isn’t open yet. This text may change before launch, and we’ll say what changed.
          </span>
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <nav aria-label="On this page" className="flex flex-col gap-3">
            <span className="font-medium text-sm">On this page</span>
            <ol className="hidden flex-col gap-1.5 text-[13.5px] lg:flex">
              {sections.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-muted-foreground transition-colors hover:text-foreground">
                    <span className="am-num mr-2 text-[12px]">{String(i + 1).padStart(2, "0")}</span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
            <ul className="mt-4 hidden flex-col gap-1.5 border-t pt-4 text-[13.5px] lg:flex">
              {LEGAL_PAGES.map((p) => (
                <li key={p.href}>
                  <Link href={p.href} className="text-muted-foreground transition-colors hover:text-foreground">
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <article className="am-site-legal min-w-0 max-w-[72ch]">
          <h1 className="am-site-h1">{title}</h1>
          <p className="am-small mt-3">
            Last updated <time dateTime={LEGAL_UPDATED}>{updated}</time>
          </p>
          <div className="am-site-lead mt-6">{lead}</div>
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="scroll-mt-28">
              <h2 id={`${s.id}-h`}>
                <span className="am-num mr-3 text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                {s.title}
              </h2>
              {s.body}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
