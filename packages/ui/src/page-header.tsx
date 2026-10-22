// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * App page header (branding.md "Page header"): breadcrumb, title, one-line description. No eyebrow label — the
 * breadcrumb carries context, and only when the page is at least two levels deep.
 */
export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${String(i)}`} className="flex items-center gap-1">
              {last || !c.href ? (
                <span aria-current={last ? "page" : undefined} className={last ? "text-foreground" : undefined}>
                  {c.label}
                </span>
              ) : (
                <a href={c.href} className="rounded transition-colors hover:text-foreground">
                  {c.label}
                </a>
              )}
              {!last && <ChevronRight className="size-3.5 opacity-60" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Console page template, top part: breadcrumb, a large title (actions may sit at its right) and an optional one-line
 * description. The command bar, filter chips and content follow it on the page.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <Breadcrumbs items={breadcrumbs} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="am-h1 min-w-0 break-words">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="am-small max-w-[80ch]">{description}</p>}
    </header>
  );
}
